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
  if (!env.KV_URL) {
    throw new Error('KV_URL is not configured. Please set the KV_URL environment variable.');
  }

  return new KV(env.KV_URL, namespace, rateLimitPrefix ?? env.RATE_LIMIT_PREFIX);
}

/**
 * Create a KV instance for rate limiting using environment configuration
 * @param namespace - Optional namespace for the KV store
 * @returns KV instance configured for rate limiting
 * @throws Error if RATE_LIMIT_REDIS_URL or KV_URL is not configured
 */
export function createRateLimitKV(namespace?: string): KV {
  const redisUrl = env.RATE_LIMIT_REDIS_URL ?? env.KV_URL;

  if (!redisUrl) {
    throw new Error(
      'Redis URL for rate limiting is not configured. Please set RATE_LIMIT_REDIS_URL or KV_URL environment variable.'
    );
  }

  return new KV(redisUrl, namespace, env.RATE_LIMIT_PREFIX);
}
