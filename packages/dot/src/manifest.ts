/**
 * Manifest types for the DOT kernel.
 *
 * A `DotAppManifest` is the static, declarative description of an app: which
 * pips are registered, what routes/services they contribute, and how they
 * depend on each other. It is built up during the `configure` phase from
 * registration calls and finalised once `configure` completes.
 *
 * CONTRACT: `DotAppManifest` always exposes the same five top-level arrays
 * (`pips`, `routes`, `services`, `lifecycle`, `dependencies`). Consumers
 * MUST NOT see an omitted array — empty is empty, but never missing.
 * This shape is referenced by Task 7's scorecard.
 */

import type { DotLifecycleHook } from './lifecycle.js';

/**
 * Kind of service that a pip can publish.
 *
 * Well-known kinds map 1:1 to the canonical `@arki/*` adapters. `custom`
 * is the escape hatch for pip-defined service kinds — use it whenever a
 * pip publishes something that does not fit a reserved shape.
 */
export type ServiceKind =
  | 'env'
  | 'db'
  | 'kv'
  | 'queue'
  | 'auth'
  | 'email'
  | 'logger'
  | 'event-store'
  | 'message-bus'
  | 'custom';

/** Transport that a route is exposed under. */
export type RouteTransport = 'http' | 'orpc' | 'trpc' | 'rpc' | 'custom';

/** Kind of dependency edge between two pips. */
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
  pips: PipManifest[];
  routes: RouteManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
};

/** Single pip's declarative metadata. */
export type PipManifest = {
  name: string;
  version?: string;
  dependencies: readonly string[];
  provides: readonly string[];
};

/** Single route exposed by a pip. */
export type RouteManifest = {
  id: string;
  pip: string;
  method?: string;
  path?: string;
  transport: RouteTransport;
};

/** Single service published by a pip. */
export type ServiceManifest = {
  name: string;
  pip: string;
  kind: ServiceKind;
};

/** Which lifecycle hooks a pip participates in. */
export type LifecycleManifest = {
  pip: string;
  hooks: readonly DotLifecycleHook[];
};

/** Directed edge in the pip dependency graph. */
export type DependencyEdge = {
  from: string;
  to: string;
  kind: DependencyEdgeKind;
};
