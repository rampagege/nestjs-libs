import { isOopsBusinessException, redactHttpHeaders } from './logger.interceptor';

import { describe, expect, it } from 'bun:test';

describe('redactHttpHeaders', () => {
  it('fully redacts authorization and cookie (no partial leak)', () => {
    const out = redactHttpHeaders({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      cookie: 'sandbox_session=secretvalue; other=1',
    });
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.cookie).toBe('[REDACTED]');
  });

  it('redacts set-cookie / proxy-authorization / x-api-key / x-auth-token', () => {
    const out = redactHttpHeaders({
      'set-cookie': 'a=b',
      'proxy-authorization': 'Basic xxx',
      'x-api-key': 'sk-123',
      'x-auth-token': 'tok',
    });
    expect(out['set-cookie']).toBe('[REDACTED]');
    expect(out['proxy-authorization']).toBe('[REDACTED]');
    expect(out['x-api-key']).toBe('[REDACTED]');
    expect(out['x-auth-token']).toBe('[REDACTED]');
  });

  it('is case-insensitive on header names', () => {
    const out = redactHttpHeaders({ Authorization: 'Bearer x', Cookie: 'c=1' });
    expect(out.Authorization).toBe('[REDACTED]');
    expect(out.Cookie).toBe('[REDACTED]');
  });

  it('preserves non-sensitive headers verbatim', () => {
    const out = redactHttpHeaders({ host: 'api.example.com', 'user-agent': 'Mozilla/5.0', 'content-length': '57486' });
    expect(out.host).toBe('api.example.com');
    expect(out['user-agent']).toBe('Mozilla/5.0');
    expect(out['content-length']).toBe('57486');
  });

  it('handles undefined → empty object', () => {
    expect(redactHttpHeaders(undefined)).toEqual({});
  });
});

describe('isOopsBusinessException', () => {
  it('returns true for IOopsException with httpStatus < 500 (BusinessException)', () => {
    const businessException = { httpStatus: 422, message: '[MG40001] 设备不在线' };
    expect(isOopsBusinessException(businessException)).toBe(true);
  });

  it('returns true for 4xx variants (400 / 403 / 404 / 422)', () => {
    expect(isOopsBusinessException({ httpStatus: 400 })).toBe(true);
    expect(isOopsBusinessException({ httpStatus: 403 })).toBe(true);
    expect(isOopsBusinessException({ httpStatus: 404 })).toBe(true);
    expect(isOopsBusinessException({ httpStatus: 422 })).toBe(true);
  });

  it('returns false for IOopsException with httpStatus >= 500 (FatalException)', () => {
    expect(isOopsBusinessException({ httpStatus: 500 })).toBe(false);
    expect(isOopsBusinessException({ httpStatus: 502 })).toBe(false);
    expect(isOopsBusinessException({ httpStatus: 503 })).toBe(false);
  });

  it('returns false for plain Error (no httpStatus)', () => {
    expect(isOopsBusinessException(new Error('something broke'))).toBe(false);
  });

  it('returns false for null / undefined / primitives', () => {
    expect(isOopsBusinessException(null)).toBe(false);
    expect(isOopsBusinessException(undefined)).toBe(false);
    expect(isOopsBusinessException('string error')).toBe(false);
    expect(isOopsBusinessException(42)).toBe(false);
  });

  it('returns false when httpStatus exists but is not a number', () => {
    expect(isOopsBusinessException({ httpStatus: '422' })).toBe(false);
    expect(isOopsBusinessException({ httpStatus: null })).toBe(false);
  });

  it('does not invoke any method on the error object (no side effects)', () => {
    let isFatalCalled = false;
    const errorWithToxicIsFatal = {
      httpStatus: 422,
      isFatal: () => {
        isFatalCalled = true;
        throw new Error('toxic');
      },
    };
    expect(isOopsBusinessException(errorWithToxicIsFatal)).toBe(true);
    expect(isFatalCalled).toBe(false);
  });
});
