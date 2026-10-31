/**
 * Manifest types for the DOT kernel.
 *
 * A `DotAppManifest` is the static, declarative description of an app: which
 * units are registered, what actions/services/projections they contribute, and how they
 * depend on each other. It is built up during the `configure` phase from
 * registration calls and finalised once `configure` completes.
 *
 * CONTRACT: `DotAppManifest` always exposes the same six top-level arrays
 * (`plugins`, `actions`, `services`, `lifecycle`, `dependencies`,
 * `projections`). Consumers MUST NOT see an omitted array — empty is empty,
 * but never missing.
 */

import { z } from 'zod';

import { isFailure } from '@arki/failure';
import { parse } from '@arki/schema';

import type { DotLifecycleHook } from './lifecycle.js';
import type { UnitRole } from './unit-contract.js';
import { dotErrorDocsUrl } from './lifecycle.js';

/** JSON-serializable value — the manifest's currency. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-serializable object used for adapter-owned manifest metadata. */
export type JsonObject = Record<string, JsonValue>;

/** Code of {@link DotManifestError}. */
export const DOT_MANIFEST_ERROR_CODE = 'ARKI_DOT_E032';

/** Manifest metadata that is not plain JSON. A `TypeError`, so existing `instanceof TypeError` checks still match. */
export class DotManifestError extends TypeError {
  readonly code = DOT_MANIFEST_ERROR_CODE;
  readonly remediation =
    'Pass plain JSON only: no functions, Dates, Maps, class instances, undefined fields, NaN or cycles.';
  readonly docsUrl = dotErrorDocsUrl(DOT_MANIFEST_ERROR_CODE);

  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'DotManifestError';
  }
}

/** Rejects a cycle or a BigInt before the schema walks the value: a cycle would never end. */
function assertSerializable(value: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new DotManifestError('Value must be JSON-serializable manifest data.', { cause: error });
  }
  if (serialized === undefined) {
    throw new DotManifestError('Value must be a JSON-serializable object.');
  }
}

/**
 * Plain JSON only: no `undefined`, `NaN`, `Infinity`, `Date`, function or class instance.
 * Zod's `z.json()` has the same shape as {@link JsonValue}.
 */
const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * Validate and narrow unknown adapter data into manifest JSON metadata.
 *
 * A schema checks the value itself, so dates, functions, undefined fields, NaN,
 * Infinity, class instances, and cycles fail instead of being silently
 * coerced in `dot explain --json`.
 */
export function toJsonObject(value: unknown): JsonObject {
  assertSerializable(value);
  const parsed = parse(jsonObjectSchema, value);
  if (isFailure(parsed)) {
    throw new DotManifestError('Value must be a JSON-serializable object without lossy coercions.', {
      cause: parsed,
    });
  }
  return parsed;
}

/**
 * Kind of service that a unit can publish.
 *
 * Well-known kinds map 1:1 to the canonical `@arki/*` adapters. `custom`
 * is the escape hatch for unit-defined service kinds — use it whenever a
 * unit publishes something that does not fit a reserved shape.
 */
export type ServiceKind =
  'env' | 'db' | 'kv' | 'queue' | 'auth' | 'email' | 'logger' | 'event-store' | 'message-bus' | 'custom';

/** Kind of dependency edge between two units. */
export type DependencyEdgeKind = 'requires' | 'provides' | 'uses';

/** Direction of a boundary interaction, viewed from the app. */
export type ActionDirection = 'in' | 'out';

/** Something the app does at a boundary — universal, serializable, tiny. */
export type ActionManifest = {
  /** Stable identifier, e.g. `orders.list` or `orders.created.consume`. */
  id: string;
  plugin: string;
  /** Adapter-owned binding name: `http`, `queue`, `cli`, `cron`, etc. */
  binding: string;
  /** `in` = world invokes/feeds the app; `out` = app emits. */
  direction: ActionDirection;
  /** Display-only address printed by `dot explain`. */
  address?: string;
  /** Human summary rendered into explain output and projected documents. */
  summary?: string;
  /** Adapter-owned, JSON-serializable detail. Opaque to the kernel. */
  meta?: Readonly<JsonObject>;
  /** Optional adapter-owned identifier+version for the meta layout. */
  metaSchema?: string;
};

/** Registered projection renderer for an adapter-owned document format. */
export type ProjectionManifest = {
  /** Document format key matched by `dot explain --as <format>`. */
  format: string;
  /** Binding this projection primarily renders. Informational. */
  binding: string;
  /** Import specifier for the projection module. */
  module: string;
  /** Unit that registered this projection. */
  plugin: string;
  /**
   * Adapter-owned, JSON-serializable data the projection module reads, for what no action carries
   * (the journal's folds and inline projections run inside a write, not at an app boundary). Opaque to the kernel.
   */
  meta?: Readonly<JsonObject>;
  /**
   * Gives the `dot dev` console a page for this projection. `title` is the page's name in the console's
   * menu. The projection module must export `consolePage(document)`: it returns the page's HTML.
   */
  console?: { readonly title: string };
};

/**
 * Top-level manifest describing the static shape of a DOT app.
 *
 * Always carries the six arrays — never omits any of them.
 */
export type DotAppManifest = {
  /** Manifest schema version. 2 = actions/projections era. */
  manifestVersion: 2;
  app: {
    name: string;
    version?: string;
  };
  plugins: UnitManifest[];
  actions: ActionManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
  projections: ProjectionManifest[];
};

/** Single unit's declarative metadata. */
export type UnitManifest = {
  name: string;
  /** Hexagon role from the app builder — see `Unit.role`. */
  role?: UnitRole;
  dependencies: readonly string[];
  provides: readonly string[];
};

/** Single service published by a unit. */
export type ServiceManifest = {
  name: string;
  plugin: string;
  kind: ServiceKind;
};

/** Which lifecycle hooks a unit participates in. */
export type LifecycleManifest = {
  plugin: string;
  hooks: readonly DotLifecycleHook[];
};

/** Directed edge in the unit dependency graph. */
export type DependencyEdge = {
  from: string;
  to: string;
  kind: DependencyEdgeKind;
  /**
   * The capability (wire key) the edge carries. Set on edges the kernel
   * derives before boot from a feature's static `provides`.
   */
  key?: string;
};
