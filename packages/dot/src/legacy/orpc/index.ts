/**
 * oRPC module for Dot framework
 *
 * This module provides oRPC initialization and utilities for building
 * type-safe APIs. It exports the plugin-friendly API and the
 * rpcFeatures for backward compatibility.
 */

// Export plugin-friendly API
export { createDotProcedures } from './init.js';
export type {
  ORPCKit,
  ORPCKitWithO,
  DotContext,
  PluginSetupContext,
} from './init.js';
export type {
  DotMiddlewareConfig,
  CreateDotProceduresOptions,
} from './types.js';

// Re-export rpcFeatures for backward compatibility
export { rpcFeatures } from './legacy.js';
