/**
 * Public plugin contract for the DOT kernel.
 *
 * A `DotPlugin` is a plain object with a name, optional dependency list, and
 * up to five lifecycle hooks. The kernel calls each hook in dependency order
 * (or reverse-dependency order for `stop`/`dispose`).
 *
 * Design constraints:
 *
 *  - `configure` is SYNC. Returning a Promise is an error — the kernel will
 *    throw {@link DotLifecycleError} with code `DOT_LIFECYCLE_E001`.
 *  - `boot` may publish services into the app; downstream plugins see them via
 *    {@link DotBootContext.services}.
 *  - `stop` and `dispose` continue through individual plugin failures and
 *    report an aggregate error.
 */

import type { DotLifecycleHook } from './lifecycle.js';
import type { DependencyEdgeKind, RouteTransport, ServiceKind } from './manifest.js';

/**
 * Aggregate registration record produced during the `configure` phase.
 *
 * The kernel exposes one of these to each plugin via {@link DotConfigureContext}
 * and uses the merged result to build the final `DotAppManifest`.
 */
export type DotManifestContribution = {
  /** Services this plugin publishes. */
  services?: readonly {
    name: string;
    kind: ServiceKind;
  }[];
  /** Routes this plugin exposes. */
  routes?: readonly {
    id: string;
    method?: string;
    path?: string;
    transport: RouteTransport;
  }[];
  /** Additional `provides` capability strings (joined with the plugin's `provides`). */
  provides?: readonly string[];
  /** Additional dependency edges. */
  dependencies?: readonly {
    to: string;
    kind?: DependencyEdgeKind;
  }[];
};

/** Context provided to a `manifest` callback. */
export type DotManifestContext<TServices extends Record<string, unknown>> = {
  pluginName: string;
  /** Services published by dependencies that have already booted (read-only). */
  services: Readonly<Partial<TServices>>;
};

/** Context provided to a `configure` hook. */
export type DotConfigureContext = {
  pluginName: string;
  /** App name. */
  appName: string;
  /**
   * Register a service this plugin publishes.
   * Registration is metadata-only — the actual service instance is returned
   * from the `boot` hook in `DotBootResult.services`.
   */
  registerService(name: string, kind: ServiceKind): void;
  /** Register a route this plugin exposes. */
  registerRoute(route: { id: string; method?: string; path?: string; transport: RouteTransport }): void;
  /** Mark the plugin as participating in a lifecycle hook. */
  registerLifecycleHook(hook: DotLifecycleHook): void;
  /** Append `provides` capability strings. */
  declareProvides(...capabilities: string[]): void;
  /** Append an extra dependency edge (alongside `plugin.dependencies`). */
  declareDependency(to: string, kind?: DependencyEdgeKind): void;
};

/** Context provided to a `boot` hook. */
export type DotBootContext = {
  pluginName: string;
  appName: string;
  /**
   * Services published by prior-booted plugins, keyed by service name.
   * Use this for dependency injection between plugins.
   */
  services: ReadonlyMap<string, unknown>;
  /** Read-only configuration bag. */
  config: Readonly<Record<string, unknown>>;
};

/** Context provided to a `start` hook. */
export type DotStartContext<TServices extends Record<string, unknown>> = {
  pluginName: string;
  appName: string;
  services: TServices;
};

/** Context provided to a `stop` hook. */
export type DotStopContext<TServices extends Record<string, unknown>> = {
  pluginName: string;
  appName: string;
  services: TServices;
};

/** Context provided to a `dispose` hook. */
export type DotDisposeContext<TServices extends Record<string, unknown>> = {
  pluginName: string;
  appName: string;
  services: TServices;
};

/** Return value of a `boot` hook. */
export type DotBootResult<TServices extends Record<string, unknown>> = {
  /** Services this plugin publishes — added to `app.services` and visible to dependent plugins. */
  services?: TServices;
};

/**
 * The DOT plugin contract.
 *
 * Default `TServices` is `Record<string, never>` so plugins that don't publish
 * services don't have to specify a type argument. Default `TManifest` is the
 * full contribution shape.
 */
export type DotPlugin<
  TServices extends Record<string, unknown> = Record<string, never>,
  TManifest extends DotManifestContribution = DotManifestContribution,
> = {
  /** Unique identifier for this plugin within the app. */
  name: string;
  /** Optional semantic version string. */
  version?: string;
  /**
   * Names of plugins this one depends on.
   * The kernel ensures dependencies are configured/booted/started first, and
   * stopped/disposed last.
   */
  dependencies?: readonly string[];
  /** Capability strings this plugin advertises (for `dependencies` resolution by capability). */
  provides?: readonly string[];

  /**
   * Optional static or callback-form manifest contribution. The kernel merges
   * this into the final manifest after `configure` runs.
   */
  manifest?: TManifest | ((ctx: DotManifestContext<TServices>) => TManifest);

  /**
   * SYNC registration hook. Declare metadata, register routes/services/jobs.
   * MUST NOT perform IO, MUST NOT return a Promise.
   */
  configure?: (ctx: DotConfigureContext) => void;

  /** Async open-resources hook. Returns published services for DI. */
  boot?: (ctx: DotBootContext) => Promise<DotBootResult<TServices>> | DotBootResult<TServices>;

  /** Async begin-active-work hook. Runs after every plugin's `boot` succeeds. */
  start?: (ctx: DotStartContext<TServices>) => Promise<void> | void;

  /** Async halt-active-work hook. Runs in reverse-topological order. */
  stop?: (ctx: DotStopContext<TServices>) => Promise<void> | void;

  /** Async release-resources hook. Runs in reverse-topological order. */
  dispose?: (ctx: DotDisposeContext<TServices>) => Promise<void> | void;
};

/**
 * Type-narrowing helper for plugin authors.
 *
 * @example
 * export const myPlugin = defineDotPlugin<{ db: MyDb }>({
 *   name: 'my-plugin',
 *   async boot() {
 *     const db = await openDb();
 *     return { services: { db } };
 *   },
 *   async dispose({ services }) {
 *     await services.db.close();
 *   },
 * });
 */
export function defineDotPlugin<TServices extends Record<string, unknown> = Record<string, never>>(
  plugin: DotPlugin<TServices>,
): DotPlugin<TServices> {
  return plugin;
}

/** Internal type alias used by the kernel to erase plugin service generics. */
export type AnyDotPlugin = DotPlugin<Record<string, unknown>, DotManifestContribution>;

/** Internal helper: extract the `provides` field from a plugin (always returns an array). */
export function pluginProvides(plugin: AnyDotPlugin): readonly string[] {
  return plugin.provides ?? [];
}

/** Internal helper: extract the `dependencies` field from a plugin (always returns an array). */
export function pluginDependencies(plugin: AnyDotPlugin): readonly string[] {
  return plugin.dependencies ?? [];
}

/** Re-exported for downstream typing. */

export { type DotAppManifest, type PluginManifest } from './manifest.js';
