import { Oops } from './oops';
import { OopsError } from './oops-error';

import { describe, expect, it } from 'bun:test';

describe('Oops (422)', () => {
  it('should have httpStatus 422', () => {
    const err = new Oops({
      errorCode: '0x0101',
      oopsCode: 'TS01',
      userMessage: 'test',
      internalDetails: 'details',
    });
    expect(err.httpStatus).toBe(422);
    expect(err.isFatal()).toBe(false);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops).toBe(true);
  });
});

describe('Oops.Block (4xx)', () => {
  it('should accept 401/403/404/409 status', () => {
    const err = new Oops.Block({
      httpStatus: 401,
      errorCode: '0x0103',
      oopsCode: 'AU01',
      userMessage: 'unauthorized',
    });
    expect(err.httpStatus).toBe(401);
    expect(err.isFatal()).toBe(false);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops.Block).toBe(true);
    expect(err instanceof Oops).toBe(false);
  });

  it('should accept 408 (request timeout) and remain non-fatal', () => {
    const err = new Oops.Block({
      httpStatus: 408,
      errorCode: '0x0101',
      oopsCode: 'ST01',
      userMessage: 'stream timeout',
    });
    expect(err.httpStatus).toBe(408);
    expect(err.isFatal()).toBe(false);
  });

  it('should accept 415 (unsupported media type) and remain non-fatal', () => {
    const err = new Oops.Block({
      httpStatus: 415,
      errorCode: '0x0101',
      oopsCode: 'ST02',
      userMessage: 'unsupported audio format',
    });
    expect(err.httpStatus).toBe(415);
    expect(err.isFatal()).toBe(false);
  });
});

describe('Oops.Panic (500)', () => {
  it('should have httpStatus 500 and be fatal', () => {
    const err = new Oops.Panic({
      errorCode: '0x0401',
      oopsCode: 'SY01',
      userMessage: '系统繁忙',
      internalDetails: 'DB down',
    });
    expect(err.httpStatus).toBe(500);
    expect(err.isFatal()).toBe(true);
    expect(err instanceof OopsError).toBe(true);
    expect(err instanceof Oops.Panic).toBe(true);
    expect(err instanceof Oops).toBe(false);
  });

  it('should default oopsCode to empty string', () => {
    const err = new Oops.Panic({
      errorCode: '0x0401',
      userMessage: '系统繁忙',
    });
    expect(err.oopsCode).toBe('');
  });

  it('should default httpStatus to 500 when omitted', () => {
    const err = new Oops.Panic({
      errorCode: '0x0401',
      oopsCode: 'SY01',
      userMessage: '系统繁忙',
    });
    expect(err.httpStatus).toBe(500);
    expect(err.isFatal()).toBe(true);
  });

  it('should accept 502 (bad gateway) and remain fatal', () => {
    const err = new Oops.Panic({
      httpStatus: 502,
      errorCode: '0x0401',
      oopsCode: 'SY02',
      userMessage: 'upstream failed',
    });
    expect(err.httpStatus).toBe(502);
    expect(err.isFatal()).toBe(true);
  });

  it('should accept 503 (service unavailable) and remain fatal', () => {
    const err = new Oops.Panic({
      httpStatus: 503,
      errorCode: '0x0401',
      oopsCode: 'SY03',
      userMessage: 'upstream unavailable',
    });
    expect(err.httpStatus).toBe(503);
    expect(err.isFatal()).toBe(true);
  });
});

describe('instanceof discrimination', () => {
  it('should distinguish all three types', () => {
    const oops = new Oops({ errorCode: '0x0101', oopsCode: 'TS01', userMessage: 'biz' });
    const block = new Oops.Block({ httpStatus: 404, errorCode: '0x0101', oopsCode: 'TS01', userMessage: 'not found' });
    const panic = new Oops.Panic({ errorCode: '0x0401', oopsCode: 'SY01', userMessage: 'panic' });

    // All are OopsError
    expect(oops instanceof OopsError).toBe(true);
    expect(block instanceof OopsError).toBe(true);
    expect(panic instanceof OopsError).toBe(true);

    // Each is only its own type
    expect(oops instanceof Oops).toBe(true);
    expect(oops instanceof Oops.Block).toBe(false);
    expect(oops instanceof Oops.Panic).toBe(false);

    expect(block instanceof Oops).toBe(false);
    expect(block instanceof Oops.Block).toBe(true);
    expect(block instanceof Oops.Panic).toBe(false);

    expect(panic instanceof Oops).toBe(false);
    expect(panic instanceof Oops.Block).toBe(false);
    expect(panic instanceof Oops.Panic).toBe(true);
  });
});
