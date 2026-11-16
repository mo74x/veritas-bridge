import { describe, expect, it, vi } from 'vitest';

vi.mock('ioredis', () => {
  return {
    default: class MockRedis {
      set = vi.fn();
      eval = vi.fn();
      quit = vi.fn();
    },
  };
});

import { canonicalizeJson, RedisLockService } from './redis-lock.service';

describe('RedisLockService & canonicalizeJson', () => {
  it('canonicalizes nested objects and arrays deterministically', () => {
    const a = {
      b: 1,
      a: { z: true, a: [2, { y: 'y', x: 'x' }] },
    };
    const b = {
      a: { a: [2, { x: 'x', y: 'y' }], z: true },
      b: 1,
    };

    expect(JSON.stringify(canonicalizeJson(a))).toBe(JSON.stringify(canonicalizeJson(b)));
  });

  it('produces identical idempotency keys regardless of nested key order', () => {
    const service = new RedisLockService();
    const key1 = service.computeIdempotencyKey('LEGACY_ERP', 'ROW-1', {
      meta: { b: 2, a: 1 },
      items: [{ sku: 'S1', qty: 3 }],
    });
    const key2 = service.computeIdempotencyKey('LEGACY_ERP', 'ROW-1', {
      items: [{ qty: 3, sku: 'S1' }],
      meta: { a: 1, b: 2 },
    });

    expect(key1).toBe(key2);
  });
});
