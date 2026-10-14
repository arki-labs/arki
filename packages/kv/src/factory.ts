import { debugKV } from './debug.js';
import { env } from './env.js';
import { KV } from './index.js';

/**
 * Create a KV instance using environment configuration
 * @param namespace - The KV namespace (typically the app key).
 *   Falls back to the KV_NAMESPACE environment variable if not provided.
 * @param rateLimitPrefix - Optional prefix for rate limiter keys (default: 'rl')
 * @returns KV instance
 * @throws Error if KV_URL is not configured
 */
export function createKV(namespace?: string, rateLimitPrefix?: string): KV {
  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;
  debugKV.debug('[factory] Creating KV instance (namespace: {namespace}, rateLimitPrefix: {rateLimitPrefix})', {
    namespace: resolvedNamespace ?? 'none',
    rateLimitPrefix: rateLimitPrefix || env.RATE_LIMIT_PREFIX,
  });

  if (!env.KV_URL) {
    debugKV.debug('[factory] KV creation failed: KV_URL not configured');
    throw new Error('KV_URL is not configured. Please set the KV_URL environment variable.');
  }

  debugKV.debug('[factory] KV instance created successfully');
  return new KV(env.KV_URL, resolvedNamespace, rateLimitPrefix ?? env.RATE_LIMIT_PREFIX);
}

/**
 * Create a KV instance for rate limiting using environment configuration
 * @param namespace - The KV namespace (typically the app key).
 *   Falls back to the KV_NAMESPACE environment variable if not provided.
 * @returns KV instance configured for rate limiting
 * @throws Error if RATE_LIMIT_REDIS_URL or KV_URL is not configured
 */
export function createRateLimitKV(namespace?: string): KV {
  const resolvedNamespace = namespace ?? env.KV_NAMESPACE;
  debugKV.debug('[factory] Creating rate limit KV instance (namespace: {namespace})', {
    namespace: resolvedNamespace ?? 'none',
  });

  const redisUrl = env.RATE_LIMIT_REDIS_URL ?? env.KV_URL;

  if (!redisUrl) {
    debugKV.debug('[factory] Rate limit KV creation failed: no Redis URL configured');
    throw new Error(
      'Redis URL for rate limiting is not configured. Please set RATE_LIMIT_REDIS_URL or KV_URL environment variable.',
    );
  }

  const usingFallback = !env.RATE_LIMIT_REDIS_URL;
  debugKV.debug('[factory] Using {source} for rate limiting (prefix: {prefix})', {
    source: usingFallback ? 'fallback KV_URL' : 'RATE_LIMIT_REDIS_URL',
    prefix: env.RATE_LIMIT_PREFIX,
  });

  debugKV.debug('[factory] Rate limit KV instance created successfully');
  return new KV(redisUrl, resolvedNamespace, env.RATE_LIMIT_PREFIX);
}
