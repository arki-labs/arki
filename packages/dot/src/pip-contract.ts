/**
 * Public pip contract for the DOT kernel.
 *
 * A `DotPip` is a plain object with a name, optional dependency list, and
 * up to five lifecycle hooks. The kernel calls each hook in dependency order
 * (or reverse-dependency order for `stop`/`dispose`).
 *
 * Design constraints:
 *
 *  - `configure` is SYNC. Returning a Promise is an error — the kernel will
 *    throw {@link DotLifecycleError} with code `DOT_LIFECYCLE_E001`.
 *  - `boot` may publish services into the app; downstream pips see them via
 *    {@link DotBootContext.services}.
 *  - `stop` and `dispose` continue through individual pip failures and
 *    report an aggregate error.
 */

import type { DotLifecycleHook } from './lifecycle.js';
import type { DependencyEdgeKind, RouteTransport, ServiceKind } from './manifest.js';

/**
 * Aggregate registration record produced during the `configure` phase.
 *
 * The kernel exposes one of these to each pip via {@link DotConfigureContext}
 * and uses the merged result to build the final `DotAppManifest`.
 */
export type DotManifestContribution = {
  /** Services this pip publishes. */
  services?: readonly {
    name: string;
    kind: ServiceKind;
  }[];
  /** Routes this pip exposes. */
  routes?: readonly {
    id: string;
    method?: string;
    path?: string;
    transport: RouteTransport;
  }[];
  /** Additional `provides` capability strings (joined with the pip's `provides`). */
  provides?: readonly string[];
  /** Additional dependency edges. */
  dependencies?: readonly {
    to: string;
    kind?: DependencyEdgeKind;
  }[];
};

/** Context provided to a `manifest` callback. */
export type DotManifestContext<TServices extends Record<string, unknown>> = {
  pipName: string;
  /** Services published by dependencies that have already booted (read-only). */
  services: Readonly<Partial<TServices>>;
};

/** Context provided to a `configure` hook. */
export type DotConfigureContext = {
  pipName: string;
  /** App name. */
  appName: string;
  /**
   * Register a service this pip publishes.
   * Registration is metadata-only — the actual service instance is returned
   * from the `boot` hook in `DotBootResult.services`.
   */
  registerService(name: string, kind: ServiceKind): void;
  /** Register a route this pip exposes. */
  registerRoute(route: { id: string; method?: string; path?: string; transport: RouteTransport }): void;
  /** Mark the pip as participating in a lifecycle hook. */
  registerLifecycleHook(hook: DotLifecycleHook): void;
  /** Append `provides` capability strings. */
  declareProvides(...capabilities: string[]): void;
  /** Append an extra dependency edge (alongside `pip.dependencies`). */
  declareDependency(to: string, kind?: DependencyEdgeKind): void;
};

/** Context provided to a `boot` hook. */
export type DotBootContext = {
  pipName: string;
  appName: string;
  /**
   * Services published by prior-booted pips, keyed by service name.
   * Use this for dependency injection between pips.
   */
  services: ReadonlyMap<string, unknown>;
  /** Read-only configuration bag. */
  config: Readonly<Record<string, unknown>>;
};

/** Context provided to a `start` hook. */
export type DotStartContext<TServices extends Record<string, unknown>> = {
  pipName: string;
  appName: string;
  services: TServices;
};

/** Context provided to a `stop` hook. */
export type DotStopContext<TServices extends Record<string, unknown>> = {
  pipName: string;
  appName: string;
  services: TServices;
};

/** Context provided to a `dispose` hook. */
export type DotDisposeContext<TServices extends Record<string, unknown>> = {
  pipName: string;
  appName: string;
  services: TServices;
};

/** Return value of a `boot` hook. */
export type DotBootResult<TServices extends Record<string, unknown>> = {
  /** Services this pip publishes — added to `app.services` and visible to dependent pips. */
  services?: TServices;
};

/**
 * The DOT pip contract.
 *
 * Default `TServices` is `Record<string, never>` so pips that don't publish
 * services don't have to specify a type argument. Default `TManifest` is the
 * full contribution shape.
 */
export type DotPip<
  TServices extends Record<string, unknown> = Record<string, never>,
  TManifest extends DotManifestContribution = DotManifestContribution,
> = {
  /** Unique identifier for this pip within the app. */
  name: string;
  /** Optional semantic version string. */
  version?: string;
  /**
   * Names of pips this one depends on.
   * The kernel ensures dependencies are configured/booted/started first, and
   * stopped/disposed last.
   */
  dependencies?: readonly string[];
  /** Capability strings this pip advertises (for `dependencies` resolution by capability). */
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

  /** Async begin-active-work hook. Runs after every pip's `boot` succeeds. */
  start?: (ctx: DotStartContext<TServices>) => Promise<void> | void;

  /** Async halt-active-work hook. Runs in reverse-topological order. */
  stop?: (ctx: DotStopContext<TServices>) => Promise<void> | void;

  /** Async release-resources hook. Runs in reverse-topological order. */
  dispose?: (ctx: DotDisposeContext<TServices>) => Promise<void> | void;
};

/**
 * Type-narrowing helper for pip authors.
 *
 * @example
 * export const myPip = defineDotPip<{ db: MyDb }>({
 *   name: 'my-pip',
 *   async boot() {
 *     const db = await openDb();
 *     return { services: { db } };
 *   },
 *   async dispose({ services }) {
 *     await services.db.close();
 *   },
 * });
 */
export function defineDotPip<TServices extends Record<string, unknown> = Record<string, never>>(
  pip: DotPip<TServices>,
): DotPip<TServices> {
  return pip;
}

/** Internal type alias used by the kernel to erase pip service generics. */
export type AnyDotPip = DotPip<Record<string, unknown>, DotManifestContribution>;

/** Internal helper: extract the `provides` field from a pip (always returns an array). */
export function pipProvides(pip: AnyDotPip): readonly string[] {
  return pip.provides ?? [];
}

/** Internal helper: extract the `dependencies` field from a pip (always returns an array). */
export function pipDependencies(pip: AnyDotPip): readonly string[] {
  return pip.dependencies ?? [];
}

/**
 * Stable error thrown by DOT pip adapters.
 *
 * Adapters MUST throw `DotPipError` (not raw `Error`) when surfacing a
 * misconfiguration, missing-input, or other fail-fast condition. Consumers
 * and coding agents can then match on a stable `code`, follow `docsUrl`,
 * and apply `remediation` without parsing the message.
 *
 * Codes are per-adapter. Recommended prefix is `<PKG>_PIP_E<NNN>` (e.g.
 * `KV_PIP_E001`, `DB_PIP_E001`). The kernel does not own the code
 * namespace — each adapter defines its own constants and links them in
 * its README.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 *
 * @example
 * ```ts
 * import { DotPipError } from '@arki/dot/pip';
 *
 * const KV_PIP_ERROR_CODES = { urlNotConfigured: 'KV_PIP_E001' } as const;
 *
 * throw new DotPipError({
 *   code: KV_PIP_ERROR_CODES.urlNotConfigured,
 *   message: '[kv] KV URL is not configured.',
 *   remediation: 'Pass options.url to kv(...) or set KV_URL in the environment.',
 *   docsUrl: 'https://arki.dev/dot/errors/kv-pip-e001',
 * });
 * ```
 */
export class DotPipError extends Error {
  /** Stable error code, e.g. `KV_PIP_E001`. */
  readonly code: string;
  /** One-sentence guidance on how to fix the underlying problem. */
  readonly remediation: string;
  /** URL of the documentation page that explains this error. */
  readonly docsUrl: string;

  constructor(args: {
    readonly code: string;
    readonly message: string;
    readonly remediation: string;
    readonly docsUrl: string;
  }) {
    super(args.message);
    this.name = 'DotPipError';
    this.code = args.code;
    this.remediation = args.remediation;
    this.docsUrl = args.docsUrl;
  }
}

/** Re-exported for downstream typing. */

export { type DotAppManifest, type PipManifest } from './manifest.js';
