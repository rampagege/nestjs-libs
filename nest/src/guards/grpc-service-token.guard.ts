/**
 * GrpcServiceTokenGuard
 *
 * 验证 gRPC 请求中的服务间共享密钥。
 * 通过 gRPC metadata 的 `x-service-token` 字段传递。
 *
 * 使用方式：
 *
 * 1. 环境变量配置（Doppler 注入）：
 *    GRPC_SERVICE_TOKEN=<shared-secret>
 *    prd/stg 必设，否则 calo-server 启动时 assertStartupSecrets() 直接拒绝
 *    （fail-closed，绝不静默放行）；local/dev 可空，guard 进入 no-op 并打 warn。
 *
 * 2. 服务端（callee）— 全局注册（calo-server 已在 app.module.ts 这样接）：
 *    ```
 *    @Module({
 *      providers: [{ provide: APP_GUARD, useClass: GrpcServiceTokenGuard }],
 *    })
 *    export class AppModule {}
 *    ```
 *
 * 3. 服务端 — 单个 Controller：
 *    ```
 *    @UseGuards(GrpcServiceTokenGuard)
 *    @Controller()
 *    export class MyGrpcController { ... }
 *    ```
 *
 * 4. 客户端（caller）— 出站注入：
 *    调用方（calo-contract / calo-agents）需在统一 gRPC client 工厂注入 metadata
 *    `x-service-token` = GRPC_SERVICE_TOKEN（与 createTracedClient 同层 middleware）。
 *    该注入不在本仓库实现 —— calo-server 自身只作为 callee 被 agents 调用。
 *
 * 安全模型：
 * - 自动跳过非 RPC 上下文（HTTP / GraphQL 健康检查等不受影响）
 * - 未配置 GRPC_SERVICE_TOKEN 时跳过验证（仅 local/dev；prd/stg 已被启动校验挡住）
 * - 配置后，缺少或错误的 token 返回 UNAUTHENTICATED
 */

import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { getAppLogger } from '@app/utils/app-logger';

import { status } from '@grpc/grpc-js';

import type { Metadata } from '@grpc/grpc-js';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

const SERVICE_TOKEN_KEY = 'x-service-token';

@Injectable()
export class GrpcServiceTokenGuard implements CanActivate {
  private readonly logger = getAppLogger('GrpcServiceTokenGuard');
  private loggedSkipOnce = false;

  canActivate(context: ExecutionContext): boolean {
    // 非 RPC 上下文直接放行（健康检查等 HTTP 端点）
    if (context.getType() !== 'rpc') return true;

    const expectedToken = process.env.GRPC_SERVICE_TOKEN;

    // 未配置 token 时跳过验证（本地开发）
    if (!expectedToken) {
      if (!this.loggedSkipOnce) {
        this.logger.warning`#canActivate GRPC_SERVICE_TOKEN not configured, skipping auth (local dev mode)`;
        this.loggedSkipOnce = true;
      }
      return true;
    }

    const rpcContext = context.switchToRpc().getContext<Metadata>();
    const tokenValues = rpcContext.get(SERVICE_TOKEN_KEY);
    const token = tokenValues.length > 0 ? String(tokenValues[0]) : undefined;

    if (!token) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Missing service token in gRPC metadata',
      });
    }

    if (token !== expectedToken) {
      throw new RpcException({
        code: status.UNAUTHENTICATED,
        message: 'Invalid service token',
      });
    }

    return true;
  }
}
