import { debugKV } from './debug';
import { env } from './env';
import { KV } from './index';

/**
 * Create a KV instance using environment configuration
 * @param namespace - Optional namespace for the KV store
 * @param rateLimitPrefix - Optional prefix for rate limiter keys (default: 'rl')
 * @returns KV instance
 * @throws Error if KV_URL is not configured
 */
export function createKV(namespace?: string, rateLimitPrefix?: string): KV {
  debugKV('[factory] Creating KV instance (namespace: %s, rateLimitPrefix: %s)', namespace || 'default', rateLimitPrefix || env.RATE_LIMIT_PREFIX);

  if (!env.KV_URL) {
    debugKV('[factory] KV creation failed: KV_URL not configured');
    throw new Error('KV_URL is not configured. Please set the KV_URL environment variable.');
  }

  debugKV('[factory] KV instance created successfully');
  return new KV(env.KV_URL, namespace, rateLimitPrefix ?? env.RATE_LIMIT_PREFIX);
}

/**
 * Create a KV instance for rate limiting using environment configuration
 * @param namespace - Optional namespace for the KV store
 * @returns KV instance configured for rate limiting
 * @throws Error if RATE_LIMIT_REDIS_URL or KV_URL is not configured
 */
export function createRateLimitKV(namespace?: string): KV {
  debugKV('[factory] Creating rate limit KV instance (namespace: %s)', namespace || 'default');

  const redisUrl = env.RATE_LIMIT_REDIS_URL ?? env.KV_URL;

  if (!redisUrl) {
    debugKV('[factory] Rate limit KV creation failed: no Redis URL configured');
    throw new Error(
      'Redis URL for rate limiting is not configured. Please set RATE_LIMIT_REDIS_URL or KV_URL environment variable.'
    );
  }

  const usingFallback = !env.RATE_LIMIT_REDIS_URL;
  debugKV('[factory] Using %s for rate limiting (prefix: %s)', usingFallback ? 'fallback KV_URL' : 'RATE_LIMIT_REDIS_URL', env.RATE_LIMIT_PREFIX);

  debugKV('[factory] Rate limit KV instance created successfully');
  return new KV(redisUrl, namespace, env.RATE_LIMIT_PREFIX);
}
