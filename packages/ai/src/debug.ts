import { debug } from '@arki/logger/debug';

/**
 * Debug logger for AI service operations (OpenAI, Anthropic)
 * Enable with: DEBUG=ai:service
 */
export const debugService = debug('ai:service');

/**
 * Debug logger for embeddings operations
 * Enable with: DEBUG=ai:embeddings
 */
export const debugEmbeddings = debug('ai:embeddings');

/**
 * Debug logger for vector search operations
 * Enable with: DEBUG=ai:vector
 */
export const debugVector = debug('ai:vector');

/**
 * Debug logger for semantic search operations
 * Enable with: DEBUG=ai:semantic
 */
export const debugSemantic = debug('ai:semantic');

/**
 * Debug logger for retry and rate limiting operations
 * Enable with: DEBUG=ai:retry
 */
export const debugRetry = debug('ai:retry');

/**
 * Debug logger for cache operations
 * Enable with: DEBUG=ai:cache
 */
export const debugCache = debug('ai:cache');

/**
 * Debug logger for orchestration flow operations
 * Enable with: DEBUG=ai:flow
 */
export const debugOrchestration = debug('ai:flow');

/**
 * Enable all AI debug logs
 * Enable with: DEBUG=ai:*
 */
