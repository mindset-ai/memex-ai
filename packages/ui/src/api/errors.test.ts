import { describe, it, expect } from 'vitest';
import {
  ApiError,
  NotFoundError,
  AuthApiError,
  OrgApiError,
  MemberApiError,
  ShareAccessError,
} from './errors';

describe('ApiError hierarchy', () => {
  it('NotFoundError sets status=404 and is an ApiError', () => {
    const err = new NotFoundError('missing');
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(err.message).toBe('missing');
    expect(err.name).toBe('NotFoundError');
  });

  it('AuthApiError preserves status + reason as code', () => {
    const err = new AuthApiError(401, 'expired_token', 'Link expired');
    expect(err.status).toBe(401);
    expect(err.reason).toBe('expired_token');
    expect(err.code).toBe('expired_token');
    expect(err.message).toBe('Link expired');
  });

  it('OrgApiError preserves errorCode + reason independently', () => {
    const err = new OrgApiError(409, 'slug_taken', 'try another', 'message');
    expect(err.status).toBe(409);
    expect(err.errorCode).toBe('slug_taken');
    expect(err.reason).toBe('try another');
    expect(err.message).toBe('message');
  });

  it('MemberApiError preserves code', () => {
    const err = new MemberApiError(400, 'last_admin', 'cannot demote');
    expect(err.status).toBe(400);
    expect(err.code).toBe('last_admin');
  });

  it('ShareAccessError maps revoked → 410, unknown → 404', () => {
    expect(new ShareAccessError('revoked', 'gone').status).toBe(410);
    expect(new ShareAccessError('unknown', 'no').status).toBe(404);
  });
});
