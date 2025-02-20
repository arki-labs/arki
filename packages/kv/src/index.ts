import Redis from 'ioredis';

export class KV {
  private readonly redis: Redis;

  constructor(
    redisUrl: string,
    private readonly namespace: string,
  ) {
    this.redis = new Redis(redisUrl);
  }

  async get(key: string) {
    const value = await this.redis.get(`${this.namespace}:${key}`);

    if (!value) {
      return null;
    }

    return JSON.parse(value);
  }

  async ratelimit(key: string, limit: number, expirationSeconds: number) {
    const keyWithNamespace = `${this.namespace}:${key}`;

    const current = await this.redis.incr(keyWithNamespace);

    if (current === 1) {
      await this.redis.expire(`${this.namespace}:${key}`, expirationSeconds);
    }

    return current <= limit;
  }

  async ensureRatelimit(key: string, limit: number, expirationSeconds: number) {
    const overLimit = await this.ratelimit(key, limit, expirationSeconds);

    if (!overLimit) {
      throw new Error('Rate limit exceeded');
    }

    return overLimit;
  }

  async set<T = unknown>(key: string, value: T, expirationSeconds?: number) {
    if (expirationSeconds) {
      return this.redis.setex(`${this.namespace}:${key}`, expirationSeconds, JSON.stringify(value));
    }

    return this.redis.set(`${this.namespace}:${key}`, JSON.stringify(value));
  }

  async exists(key: string) {
    const value = await this.redis.exists(`${this.namespace}:${key}`);
    return value === 1;
  }

  async mset(keyValuePairs: Record<string, string>) {
    return this.redis.mset(
      Object.entries(keyValuePairs).map(([key, value]) => [`${this.namespace}:${key}`, JSON.stringify(value)]),
    );
  }

  async mget(keys: string[]) {
    const values = await this.redis.mget(keys.map(key => `${this.namespace}:${key}`));

    return values.map(value => (value ? JSON.parse(value) : null));
  }

  async inc(key: string, amount = 1) {
    return this.redis.incrby(`${this.namespace}:${key}`, amount);
  }

  async dec(key: string, amount = 1) {
    return this.redis.decrby(`${this.namespace}:${key}`, amount);
  }

  async delete(key: string) {
    return this.redis.del(`${this.namespace}:${key}`);
  }

  async keys(pattern: string) {
    const keys = await this.redis.keys(`${this.namespace}:${pattern}`);

    return keys.map(key => key.replace(`${this.namespace}:`, ''));
  }

  async clear() {
    const keys = await this.keys('*');

    await Promise.all(keys.map(key => this.delete(key)));

    return keys;
  }

  async close() {
    await this.redis.quit();
  }
}
