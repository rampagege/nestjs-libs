import { APICallError, wrapLanguageModel } from 'ai';

import type { LanguageModel } from 'ai';

/** Preserve control fields needed for retries/abort, never provider text or causes. */
export function privateModelError(error: unknown): Error {
  if (APICallError.isInstance(error))
    return new APICallError({
      message: 'Private model request failed',
      url: '[redacted]',
      requestBodyValues: {},
      statusCode: error.statusCode,
      isRetryable: error.isRetryable,
    });
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    return new DOMException('Private model request interrupted', error.name);
  return new Error('Private model request failed');
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
