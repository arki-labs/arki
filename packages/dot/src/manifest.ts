/**
 * Manifest types for the DOT kernel.
 *
 * A `DotAppManifest` is the static, declarative description of an app: which
 * plugins are registered, what actions/services/projections they contribute, and how they
 * depend on each other. It is built up during the `configure` phase from
 * registration calls and finalised once `configure` completes.
 *
 * CONTRACT: `DotAppManifest` always exposes the same six top-level arrays
 * (`plugins`, `actions`, `services`, `lifecycle`, `dependencies`,
 * `projections`). Consumers MUST NOT see an omitted array — empty is empty,
 * but never missing.
 */

import type { DotLifecycleHook } from './lifecycle.js';

/** JSON-serializable value — the manifest's currency. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** JSON-serializable object used for adapter-owned manifest metadata. */
export type JsonObject = { [key: string]: JsonValue };

function jsonRoundTrip(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('Value must be JSON-serializable manifest data.', { cause: error });
  }
  if (serialized === undefined) {
    throw new TypeError('Value must be a JSON-serializable object.');
  }
  return JSON.parse(serialized) as unknown;
}

function isJsonPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (isJsonPrimitive(value)) return typeof value !== 'number' || Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isPlainObject(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonObject(value: unknown): value is JsonObject {
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function jsonDeepEqual(left: unknown, right: unknown): boolean {
  if (isJsonPrimitive(left) || isJsonPrimitive(right)) return Object.is(left, right);
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonDeepEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) return false;
  for (const [key, value] of leftEntries) {
    if (!Object.hasOwn(right, key) || !jsonDeepEqual(value, right[key])) return false;
  }
  return true;
}

/**
 * Validate and narrow unknown adapter data into manifest JSON metadata.
 *
 * The check intentionally compares the original value against a
 * JSON.stringify/parse round trip. Dates, functions, undefined fields, NaN,
 * Infinity, class instances, and cycles fail instead of being silently
 * coerced in `dot explain --json`.
 */
export function toJsonObject(value: unknown): JsonObject {
  const parsed = jsonRoundTrip(value);
  if (!isJsonObject(parsed) || !jsonDeepEqual(value, parsed)) {
    throw new TypeError('Value must be a JSON-serializable object without lossy coercions.');
  }
  return parsed;
}

/**
 * Kind of service that a plugin can publish.
 *
 * Well-known kinds map 1:1 to the canonical `@arki/*` adapters. `custom`
 * is the escape hatch for plugin-defined service kinds — use it whenever a
 * plugin publishes something that does not fit a reserved shape.
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

/** Kind of dependency edge between two plugins. */
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
  /** Plugin that registered this projection. */
  plugin: string;
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
  plugins: PluginManifest[];
  actions: ActionManifest[];
  services: ServiceManifest[];
  lifecycle: LifecycleManifest[];
  dependencies: DependencyEdge[];
  projections: ProjectionManifest[];
};

/** Single plugin's declarative metadata. */
export type PluginManifest = {
  name: string;
  version?: string;
  dependencies: readonly string[];
  provides: readonly string[];
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
