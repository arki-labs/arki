/**
 * Manifest types for the DOT kernel.
 *
 * A `DotAppManifest` is the static, declarative description of an app: which
 * plugins are registered, what routes/services they contribute, and how they
 * depend on each other. It is built up during the `configure` phase from
 * registration calls and finalised once `configure` completes.
 *
 * CONTRACT: `DotAppManifest` always exposes the same five top-level arrays
 * (`plugins`, `routes`, `services`, `lifecycle`, `dependencies`). Consumers
 * MUST NOT see an omitted array — empty is empty, but never missing.
 * This shape is referenced by Task 7's scorecard.
 */

import type { DotLifecycleHook } from './lifecycle.js';

/**
 * Kind of service that a plugin can publish.
 *
 * The first eight kinds are reserved well-known shapes the framework knows
 * about. `custom` is the escape hatch for plugin-defined service kinds.
 */
export type ServiceKind = 'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger' | 'custom';

/** Transport that a route is exposed under. */
export type RouteTransport = 'http' | 'orpc' | 'trpc' | 'rpc' | 'custom';

/** Kind of dependency edge between two plugins. */
export type DependencyEdgeKind = 'requires' | 'provides' | 'uses';

/**
 * Top-level manifest describing the static shape of a DOT app.
 *
 * Always carries the five arrays — never omits any of them.
 */
export type DotAppManifest = {
  app: {
    name: string;
    version?: string;
  };
  plugins: PluginManifest[];
  routes: RouteManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
};

/** Single plugin's declarative metadata. */
export type PluginManifest = {
  name: string;
  version?: string;
  dependencies: readonly string[];
  provides: readonly string[];
};

/** Single route exposed by a plugin. */
export type RouteManifest = {
  id: string;
  plugin: string;
  method?: string;
  path?: string;
  transport: RouteTransport;
};

/** Single service published by a plugin. */
export type ServiceManifest = {
  name: string;
  plugin: string;
  kind: ServiceKind;
};

/** Which lifecycle hooks a plugin participates in. */
export type LifecycleManifest = {
  plugin: string;
  hooks: readonly DotLifecycleHook[];
};

/** Directed edge in the plugin dependency graph. */
export type DependencyEdge = {
  from: string;
  to: string;
  kind: DependencyEdgeKind;
};
