import { APICallError, NoObjectGeneratedError, NoOutputGeneratedError, wrapLanguageModel } from 'ai';

import type { LanguageModel } from 'ai';

/**
 * Fallback classification keys off the error type and off two textual markers.
 * Redaction has to preserve both or a private call silently stops falling back
 * to its secondary models — see `isRetryableError` in `llm.class.ts`, which
 * treats NoObjectGeneratedError, NoOutputGeneratedError, provider reasoning
 * policy and timeouts as retryable. `private-model.spec.ts` pins the invariant.
 *
 * Provider policy and timeout wording are control signals, not user content.
 */
const REASONING_POLICY_PATTERN = /reasoning is mandatory|cannot be disabled/i;
const TIMEOUT_PATTERN = /timed out/i;

function classificationSafeMessage(error: unknown): string {
  const text = APICallError.isInstance(error)
    ? `${error.message} ${error.responseBody ?? ''}`
    : error instanceof Error
      ? error.message
      : String(error);
  if (REASONING_POLICY_PATTERN.test(text)) return 'Private model request failed: reasoning is mandatory';
  if (TIMEOUT_PATTERN.test(text)) return 'Private model request failed: request timed out';
  return 'Private model request failed';
}

/** Keep the type and the control fields retries/abort need, never text or causes. */
export function privateModelError(error: unknown): Error {
  const message = classificationSafeMessage(error);
  if (APICallError.isInstance(error))
    return new APICallError({
      message,
      url: '[redacted]',
      requestBodyValues: {},
      statusCode: error.statusCode,
      isRetryable: error.isRetryable,
    });
  // Copy only classification metadata. `text` is model output; `headers` and `body`
  // are the provider payload. The SDK types these constructor fields as required
  // while the instance itself keeps them optional, hence the cast.
  if (NoObjectGeneratedError.isInstance(error))
    return new NoObjectGeneratedError({
      message,
      finishReason: error.finishReason,
      usage: error.usage,
      response: error.response
        ? { id: error.response.id, timestamp: error.response.timestamp, modelId: error.response.modelId }
        : undefined,
    } as unknown as ConstructorParameters<typeof NoObjectGeneratedError>[0]);
  if (NoOutputGeneratedError.isInstance(error)) return new NoOutputGeneratedError({ message });
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return new DOMException('Private model request interrupted', error.name);
  return new Error(message);
}

/** Remove provider request/response payloads before the SDK records an exception. */
export function privateModel(model: LanguageModel, enabled: boolean): LanguageModel {
  if (!enabled) return model;
  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]['model'],
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ doGenerate }) => {
        try {
          return await doGenerate();
        } catch (error) {
          throw privateModelError(error);
        }
      },
      wrapStream: async ({ doStream }) => {
        try {
          const result = await doStream();
          const reader = result.stream.getReader();
          return {
            ...result,
            stream: new ReadableStream({
              async pull(controller) {
                try {
                  const { done, value } = await reader.read();
                  if (done) {
                    controller.close();
                    return;
                  }
                  controller.enqueue(
                    value.type === 'error' ? { ...value, error: privateModelError(value.error) } : value,
                  );
                } catch (error) {
                  controller.error(privateModelError(error));
                }
              },
              cancel: (reason) => reader.cancel(reason),
            }),
          };
        } catch (error) {
          throw privateModelError(error);
        }
      },
    },
  });
}
