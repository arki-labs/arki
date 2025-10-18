/**
 * tRPC module for Dot framework
 *
 * This module provides tRPC initialization and utilities for building
 * type-safe APIs. It exports both the new plugin-friendly API and the
 * legacy trpcFeatures for backward compatibility.
 */

// Export new plugin-friendly API
export { createDotProcedures } from './init';
export type {
  TRPCKit,
  TRPCKitWithT,
  DotContext,
  PluginSetupContext,
} from './init';
export type {
  DotTRPCMiddlewareConfig,
  CreateDotProceduresOptions,
} from './types';

// Re-export legacy trpcFeatures for backward compatibility
export { trpcFeatures } from './legacy';
