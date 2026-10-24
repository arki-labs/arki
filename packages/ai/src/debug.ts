import { getLogger } from '@arki/log';

/**
 * Debug logger for AI service operations (OpenAI, Anthropic)
 * Enable with: DEBUG=ai:service
 */
export const debugService = getLogger('ai:service');

/**
 * Debug logger for vector search operations
 * Enable with: DEBUG=ai:vector
 */
export const debugVector = getLogger('ai:vector');

/**
 * Debug logger for semantic search operations
 * Enable with: DEBUG=ai:semantic
 */
export const debugSemantic = getLogger('ai:semantic');

/**
 * Debug logger for retry and rate limiting operations
 * Enable with: DEBUG=ai:retry
 */
export const debugRetry = getLogger('ai:retry');

/**
 * Debug logger for cache operations
 * Enable with: DEBUG=ai:cache
 */
export const debugCache = getLogger('ai:cache');

/**
 * Debug logger for orchestration flow operations
 * Enable with: DEBUG=ai:flow
 */
export const debugOrchestration = getLogger('ai:flow');

/**
 * Debug logger for the agent-runtime adapter layer
 * Enable with: DEBUG=ai:runtime
 */
export const debugRuntime = getLogger('ai:runtime');

/**
 * Enable all AI debug logs
 * Enable with: DEBUG=ai:*
 */
