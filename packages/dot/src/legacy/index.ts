/**
 * @fileoverview Legacy barrel — re-exports the deprecated `Dot` / `createDot`
 * / `definePlugin` surface for backward compatibility.
 *
 * @deprecated Use `defineApp` from `@arki/dot` instead. The legacy surface is
 * preserved as @deprecated aliases and will be removed in a future major
 * version.
 */

// Legacy builder + types
export { Dot, createDot } from './dot.js';
export * from './types.js';
export { definePlugin, PluginBuilder, type PluginConfig, type PluginContext } from './plugin.js';

// Legacy context management utilities
export * from './context/index.js';

// Legacy oRPC module (portable API)
export { createDotProcedures } from './orpc/index.js';
export type { DotContext, PluginSetupContext, ORPCKit, ORPCKitWithO } from './orpc/index.js';
export type { CreateDotProceduresOptions, DotMiddlewareConfig } from './orpc/types.js';

// Legacy auth module
export {
  authPresets,
  createAuthConfigFromEnv,
  createDotAuth,
  dotAuthIntegration,
  sessionUtils,
  type BuiltInProvider,
  type CustomProvider,
  type DotAuth,
  type DotAuthConfig,
  type DotRBACManager,
  type DotSession,
  type DotSessionManager,
  type DotUser,
  type EmailConfig,
  type MFAConfig,
  type Permission,
  type PolicyContext,
  type ProviderConfigs,
  type RBACConfig,
  type Role,
  type SecurityConfig,
  type SessionConfig,
} from './auth/index.js';

// Legacy auth features
export { authFeatures } from './auth/index.js';
