import { GrpcExceptionFilter } from './grpc-exception.filter';
import { Oops } from './oops';

import './oops-factories';

import { Metadata, status } from '@grpc/grpc-js';
import { describe, expect, it } from 'bun:test';
import { firstValueFrom } from 'rxjs';

import type { ArgumentsHost } from '@nestjs/common';

// ==================== Test Helpers ====================

/** 模拟 BusinessException (isFatal=false) */
function mockBusinessException(overrides?: Partial<{ businessCode: string; userMessage: string }>) {
  return Object.assign(new Error('business error'), {
    httpStatus: 422,
    errorCode: '0x0302',
    businessCode: overrides?.businessCode ?? 'MG40001',
    userMessage: overrides?.userMessage ?? '设备不在线',
    internalDetails: 'device offline',
    provider: 'marsgate',
    isFatal: () => false,
    getCombinedCode: () => '0x0302MG40001',
  });
}

/** 模拟 FatalException (isFatal=true) */
function mockFatalException() {
  return Object.assign(new Error('fatal error'), {
    httpStatus: 500,
    errorCode: '0x0305',
    businessCode: 'EXTERNAL_ERROR',
    userMessage: '服务暂时不可用',
    internalDetails: 'connection refused',
    provider: 'marsgate',
    isFatal: () => true,
    getCombinedCode: () => '0x0305EXTERNAL_ERROR',
  });
}

/** 模拟 ArgumentsHost（gRPC 上下文） */
function mockGrpcHost() {
  const sentMetadata: Metadata[] = [];
  const callObj = {
    sendMetadata: (m: Metadata) => sentMetadata.push(m),
  };

  const host: ArgumentsHost = {
    switchToRpc: () => ({
      getData: () => ({}),
      getContext: () => new Metadata(),
    }),
    switchToHttp: () => ({ getRequest: () => ({}), getResponse: () => ({}) }) as never,
    switchToWs: () => ({ getClient: () => ({}), getData: () => ({}) }) as never,
    getArgs: () => [{}, new Metadata(), callObj],
    getArgByIndex: (index: number) => [undefined, undefined, callObj][index],
    getType: () => 'rpc' as const,
  } as unknown as ArgumentsHost;

  return { host, sentMetadata, callObj };
}

// ==================== Tests ====================

describe('GrpcExceptionFilter', () => {
  const filter = new GrpcExceptionFilter('test-provider');

  describe('BusinessException (isFatal=false)', () => {
    it('should return OK status with x-oops-error-bin metadata', async () => {
      const { host, sentMetadata } = mockGrpcHost();
      const exception = mockBusinessException();

      const result$ = filter.catch(exception, host);
      const response = await firstValueFrom(result$);

      // 返回空对象（OK response）
      expect(response).toEqual({});

      // 发送了 initial metadata
      expect(sentMetadata).toHaveLength(1);
      const errorHeader = sentMetadata[0]!.get('x-oops-error-bin');
      expect(errorHeader).toHaveLength(1);

      // -bin metadata 返回 Buffer，decode 为 JSON
      const parsed = JSON.parse(Buffer.from(errorHeader[0] as Buffer).toString('utf-8'));
      expect(parsed.httpStatus).toBe(422);
      expect(parsed.businessCode).toBe('MG40001');
      expect(parsed.userMessage).toBe('设备不在线');
      expect(parsed.provider).toBe('marsgate');
    });
  });

  describe('FatalException (isFatal=true)', () => {
    it('should throw gRPC error with non-OK status code', async () => {
      const { host } = mockGrpcHost();
      const exception = mockFatalException();

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false); // should not reach
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.INTERNAL);
        const parsed = JSON.parse(grpcError.details);
        expect(parsed.httpStatus).toBe(500);
      }
    });
  });

  describe('ZodError', () => {
    it('should throw INVALID_ARGUMENT (unchanged behavior)', async () => {
      const { ZodError } = await import('zod');
      const { host } = mockGrpcHost();
      const exception = new ZodError([
        { code: 'invalid_type', expected: 'string', path: ['id'], message: 'Expected string' } as never,
      ]);

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.INVALID_ARGUMENT);
      }
    });
  });

  describe('Oops V2 instances', () => {
    it('Oops (422) should return OK with metadata', async () => {
      const { host, sentMetadata } = mockGrpcHost();
      const exception = Oops.Validation('bad input', 'field missing');

      const result$ = filter.catch(exception, host);
      const response = await firstValueFrom(result$);

      expect(response).toEqual({});
      expect(sentMetadata).toHaveLength(1);
    });

    it('Oops.Block (401) should throw UNAUTHENTICATED', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Block.Unauthorized('expired token');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.UNAUTHENTICATED);
      }
    });

    it('Oops.Block (404) should throw NOT_FOUND', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Block.NotFound('User', 'u_123');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.NOT_FOUND);
      }
    });

    it('Oops.Panic (500) should throw INTERNAL', async () => {
      const { host } = mockGrpcHost();
      const exception = Oops.Panic.Database('query failed');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number };
        expect(grpcError.code).toBe(status.INTERNAL);
      }
    });
  });

  describe('HttpException (unmatched HTTP route on the hybrid health server)', () => {
    it('NotFoundException (404) maps to NOT_FOUND, not INTERNAL — stray probe is a 4xx client error', async () => {
      // POST /graphql / POST /health on a gRPC service (only GET /health* exists) → NotFoundException.
      // Before: fell to handleUnexpectedError → ERROR + Sentry + gRPC INTERNAL(500). Now: client 4xx.
      const { NotFoundException } = await import('@nestjs/common');
      const { host } = mockGrpcHost();
      const exception = new NotFoundException('Cannot POST /graphql');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.NOT_FOUND);
        const parsed = JSON.parse(grpcError.details);
        expect(parsed.httpStatus).toBe(404);
        expect(parsed.businessCode).toBe('CLIENT_ERROR'); // not INTERNAL_ERROR
      }
    });

    it('a 5xx HttpException still maps to INTERNAL (ERROR path preserved)', async () => {
      const { InternalServerErrorException } = await import('@nestjs/common');
      const { host } = mockGrpcHost();
      const exception = new InternalServerErrorException('boom');

      const result$ = filter.catch(exception, host);

      try {
        await firstValueFrom(result$);
        expect(true).toBe(false);
      } catch (error: unknown) {
        const grpcError = error as { code: number; details: string };
        expect(grpcError.code).toBe(status.INTERNAL);
        expect(JSON.parse(grpcError.details).businessCode).toBe('INTERNAL_ERROR');
      }
    });
  });
});
