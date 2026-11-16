import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import Redis from 'ioredis';

@Injectable()
export class RedisLockService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * Computes a deterministic SHA-256 idempotency key from source metadata and raw payload.
   */
  computeIdempotencyKey(
    sourceSystem: string,
    sourceRecordId: string,
    payload: Record<string, unknown>,
  ): string {
    const sortedKeys = Object.keys(payload).sort();
    const canonicalPayload: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      canonicalPayload[key] = payload[key];
    }

    return createHash('sha256')
      .update(`${sourceSystem}:${sourceRecordId}:${JSON.stringify(canonicalPayload)}`)
      .digest('hex');
  }

  /**
   * Acquires an atomic Redis distributed lock (preventing concurrent duplicate syncs or echo loops).
   * Returns a lock token if acquired, or null if already locked.
   */
  async acquireLock(resourceKey: string, ttlMs = 15_000): Promise<string | null> {
    const token = randomUUID();
    const result = await this.redis.set(`lock:${resourceKey}`, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  }

  /**
   * Releases the lock only if the caller still owns the token (via atomic Lua script).
   */
  async releaseLock(resourceKey: string, token: string): Promise<void> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.eval(luaScript, 1, `lock:${resourceKey}`, token);
  }
}