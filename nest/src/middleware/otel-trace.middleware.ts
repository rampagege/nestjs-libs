/**
 * HTTP tracing middleware —— 职责是**写 trace response header**（X-Trace-Id / traceparent）。
 *
 * 为什么放在 middleware 层：NestJS 执行顺序是 middleware → guard → interceptor → handler → filter。
 * 如果 guard 抛 UnauthorizedException，interceptor 不会执行，客户端拿到的错误响应就没
 * trace 信息，iOS / 日志排障都没法关联。middleware 在 guard 之前执行，这里写 header 能
 * 保证成功和异常两条路径都带上。
 *
 * 两种运行模式：
 * 1. **Sentry 模式**（`SENTRY_DSN` 已配置）：Sentry 通过 `instrument.js` 预加载已经挂了
 *    HttpInstrumentation，active context 里已经有 SERVER span。我们只需要读出来写 header，
 *    不再建重复的 span。
 * 2. **非 Sentry 模式**：我们自己建一个 SERVER span（让 GrpcInstrumentation 有 parent
 *    context 可传播），然后写 header。替代 @opentelemetry/instrumentation-http 的
 *    HttpInstrumentation —— 后者通过 context.bind(req/res) patch EventEmitter，在
 *    Apollo + Bun/JSC 下放大内存泄漏（https://github.com/open-telemetry/opentelemetry-js/issues/5514）。
 *
 * 两种模式都**不**调用 context.bind(req/res)，不 patch EventEmitter。
 */
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

import type { Context, Span } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';

/**
 * Baggage key 用来跨进程携带 sandbox tags。
 *
 * 写入: 本中间件检测到 sandbox header 后, 把 JSON.stringify(tags) 塞进 baggage,
 * W3C Baggage propagator 通过 gRPC metadata 自动透传到 calo-agents。
 *
 * 读取: calo-agents libs `features/llm/clients/baggage-tags.ts mergeBaggageTags`
 * 在 LLM 调用前合并进 AI SDK `experimental_telemetry.metadata.tags`, 让 tag
 * 落到 ai-scope span (Langfuse 唯一放行的 scope), 最终出现在 Langfuse trace.tags。
 *
 * 为什么走 baggage 而非 setAttribute on root span: HTTP root span scope='http-server',
 * libs/instrument.ts shouldExportSpan 仅放 scope='ai' 给 Langfuse processor, root span
 * attribute 永远到不了 Langfuse。
 */
const SANDBOX_TAGS_BAGGAGE_KEY = 'sandbox.tags';

const tracer = trace.getTracer('http-server');

function writeTraceHeaders(res: Response, traceId: string, spanId: string): void {
  // W3C Trace Context 标准格式: 00-{traceId}-{spanId}-{flags}，flags: 01 表示已采样
  res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
  res.setHeader('X-Trace-Id', traceId);
}

/**
 * Sandbox-origin trace 自动 tag 检测（MIS-423 Phase 3 fixture provenance）
 *
 * calo-sandbox 发请求时挂以下 header：
 *   X-Client-Type: sandbox
 *   X-Sandbox-Source: scenario | eval
 *   X-Sandbox-Scenario: <scenario id>           (scenario runner)
 *   X-Sandbox-Eval: <eval id>                   (eval runner)
 *   X-Sandbox-Workspace: staging                (scenario runner)
 *
 * 中间件检测到任一 sandbox 标识就给 trace 打 tags，下游 observability-mcp
 * `replay_to_fixture` 用 `tags.includes('sandbox-origin')` 过滤来源——
 * sandbox-origin trace 用合成 family、零真实用户 PII，可直接抽 fixture
 * 进 git；prod-origin 走 redaction + opt-in 路径。
 *
 * 仅识别 string 值的 header；express 多值场景给 array 时跳过，避免
 * 异常输入污染 tag 列表。
 */
export function detectSandboxTags(req: Request): string[] | undefined {
  const clientType = req.headers['x-client-type'];
  const sandboxSource = req.headers['x-sandbox-source'];

  const isSandboxClient = clientType === 'sandbox';
  const hasSandboxSource = typeof sandboxSource === 'string';
  if (!isSandboxClient && !hasSandboxSource) return undefined;

  const tags: string[] = ['sandbox-origin'];
  if (hasSandboxSource) tags.push(`source:${sandboxSource}`);

  const scenario = req.headers['x-sandbox-scenario'];
  if (typeof scenario === 'string') tags.push(`scenario:${scenario}`);

  const evalId = req.headers['x-sandbox-eval'];
  if (typeof evalId === 'string') tags.push(`eval:${evalId}`);

  const workspace = req.headers['x-sandbox-workspace'];
  if (typeof workspace === 'string') tags.push(`workspace:${workspace}`);

  return tags;
}

/**
 * 把 sandbox tag 写到 root span 上 (诊断 / fullStack export 时有用) +
 * 写入 OTel Baggage (跨进程传到 calo-agents LLM call site)。
 *
 * 返回带 baggage 的新 context, caller 应用 context.with(newCtx, () => next())
 * 包裹下游执行, 让 W3C Baggage propagator 在出站 gRPC 时序列化。
 */
function applySandboxTags(span: Span, req: Request, ctx: Context): Context {
  const tags = detectSandboxTags(req);
  if (!tags) return ctx;
  span.setAttribute('ai.telemetry.metadata.tags', tags);
  const baggage = propagation.createBaggage({
    [SANDBOX_TAGS_BAGGAGE_KEY]: { value: JSON.stringify(tags) },
  });
  return propagation.setBaggage(ctx, baggage);
}

export function otelTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const url = req.url || '';

  // 健康检查不建 span 也不写 trace header（K8s probe 不需要）
  if (url === '/' || url.startsWith('/health')) {
    next();
    return;
  }

  // Sentry 模式：Sentry 的 HttpInstrumentation 已在 request 进入时创建了 SERVER span，
  // 本 middleware 跑到这一刻 active context 里就有 Sentry 的 span。我们只需读取 + 写 header。
  // 如果自己再建 span，会变成 Sentry span 的子 span —— traceId 相同但 response 里 spanId
  // 会偏离 Sentry 看到的那个，给联调带来困扰。
  if (process.env.SENTRY_DSN) {
    const activeSpan = trace.getSpan(context.active());
    if (activeSpan) {
      const { traceId, spanId } = activeSpan.spanContext();
      writeTraceHeaders(res, traceId, spanId);
      const ctxWithBaggage = applySandboxTags(activeSpan, req, context.active());
      // 若有 baggage 注入则 context.with 包裹 next, 保证下游 gRPC 出站时 propagator 看得到。
      if (ctxWithBaggage !== context.active()) {
        context.with(ctxWithBaggage, () => { next(); });
        return;
      }
    }
    next();
    return;
  }

  // 非 Sentry 模式：自建 SERVER span
  // 从请求头提取 propagation context（支持上游传入 traceparent）
  const parentCtx = propagation.extract(context.active(), req.headers);

  const span = tracer.startSpan(`${req.method} ${url}`, { kind: SpanKind.SERVER }, parentCtx);

  const spanCtx = trace.setSpan(parentCtx, span);
  const { traceId, spanId } = span.spanContext();

  // 在 next() 之前写 header，保证 guard 异常路径也能拿到 —— filter 渲染错误响应时 header 已就位
  writeTraceHeaders(res, traceId, spanId);
  const finalCtx = applySandboxTags(span, req, spanCtx);

  // 在 span context + sandbox baggage 下执行后续 middleware/handler
  context.with(finalCtx, () => {
    res.on('finish', () => {
      span.setAttribute('http.status_code', res.statusCode);
      span.end();
    });
    next();
  });
}
