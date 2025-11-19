/**
 * Debug logging configuration for @arki/dot package
 *
 * Enable debug logging by setting the DEBUG environment variable:
 *
 * - DEBUG=dot:* - All dot package logs
 * - DEBUG=dot:trpc - Only tRPC initialization and procedure logs
 * - DEBUG=dot:auth - Only authentication logs
 * - DEBUG=dot:context - Only context creation logs
 * - DEBUG=dot:plugin - Only plugin logs
 * - DEBUG=dot:db - Only database operation logs
 * - DEBUG=dot:kv - Only KV operation logs
 * - DEBUG=dot:event-sourcing - Only event sourcing logs
 *
 * Multiple namespaces can be enabled:
 * DEBUG=dot:trpc,dot:auth
 */

import { createDebugLogger } from '@arki/logger/debug';

// tRPC infrastructure debugging
export const debugTRPC = createDebugLogger('dot:trpc');

// Authentication debugging
export const debugAuth = createDebugLogger('dot:auth');

// Context creation debugging
export const debugContext = createDebugLogger('dot:context');

// Plugin debugging
export const debugPlugin = createDebugLogger('dot:plugin');

// Database operations debugging
export const debugDB = createDebugLogger('dot:db');

// KV operations debugging
export const debugKV = createDebugLogger('dot:kv');

// Event sourcing debugging
export const debugEventSourcing = createDebugLogger('dot:event-sourcing');
