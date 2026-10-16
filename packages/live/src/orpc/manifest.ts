import type { AnyContractRouter } from '@orpc/contract';
import { traverseContractProcedures } from '@orpc/server';
import { z } from 'zod';

import type { LiveKeyKind, LiveManifest, LiveMeta, LiveScopes } from '../types.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { liveManifestSchema, liveMetaSchema } from '../schema.js';
import { checkScopes } from '../scopes.js';

type Entry = LiveManifest[number];
type MetaScope = NonNullable<NonNullable<LiveMeta['live']>['scope']>;

/** An input schema that can describe itself: Standard JSON Schema (Zod 4.2+, and others). */
const describable = z.object({
  '~standard': z.object({
    jsonSchema: z.object({
      input: z.custom<(options: { readonly target: 'draft-2020-12' }) => unknown>(value => typeof value === 'function'),
    }),
  }),
});

/** The parts of a JSON Schema node a path walk reads. */
const jsonNode = z.looseObject({
  properties: z.record(z.string(), z.unknown()).optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
  allOf: z.array(z.unknown()).optional(),
  $ref: z.string().optional(),
  $defs: z.record(z.string(), z.unknown()).optional(),
});

/** Whether `path` names a property of `node` (through unions, intersections and local `$ref`s). */
function hasPath(node: unknown, path: readonly string[], defs: Readonly<Record<string, unknown>>, depth = 0): boolean {
  const parsed = jsonNode.safeParse(node);
  if (!parsed.success || depth > 64) return false;
  const { properties, anyOf, oneOf, allOf, $ref } = parsed.data;
  if ($ref?.startsWith('#/$defs/')) return hasPath(defs[$ref.slice('#/$defs/'.length)], path, defs, depth + 1);
  const [head, ...rest] = path;
  if (head === undefined) return true;
  if (properties !== undefined && Object.hasOwn(properties, head) && hasPath(properties[head], rest, defs, depth + 1)) {
    return true;
  }
  return [...(anyOf ?? []), ...(oneOf ?? []), ...(allOf ?? [])].some(branch => hasPath(branch, path, defs, depth + 1));
}

/** Whether the procedure's input schema has `path`; E001 when it cannot say. */
function inputHasPath(inputSchema: unknown, path: readonly string[], where: string): boolean {
  if (path.length === 0) return inputSchema !== undefined;
  const schema = describable.safeParse(inputSchema);
  if (!schema.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: the input schema cannot describe itself, so the scope path cannot be checked`,
      "Use an input schema with Standard JSON Schema (Zod 4.2+), or scope the procedure by 'session'.",
    );
  }
  const root: unknown = schema.data['~standard'].jsonSchema.input({ target: 'draft-2020-12' });
  const parsed = jsonNode.safeParse(root);
  return hasPath(root, path, parsed.success ? (parsed.data.$defs ?? {}) : {});
}

/** The manifest form of a procedure's scope: dimensions checked, paths checked, each input path with its key kind. */
function scopeOf(
  scope: MetaScope,
  kinds: ReadonlyMap<string, LiveKeyKind>,
  inputSchema: unknown,
  path: readonly string[],
): NonNullable<Entry['scope']> {
  const sources: NonNullable<Entry['scope']> = {};
  for (const [dimension, source] of Object.entries(scope)) {
    const where = `liveManifest(): ${path.join('.')} scope ${dimension}`;
    const kind = kinds.get(dimension);
    if (kind === undefined) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `${where}: no such dimension`,
        `Declare it in liveScopes() and pass it: liveManifest(contract, { scopes }). Known: ${[...kinds.keys()].join(', ') || 'none'}.`,
      );
    }
    if (source.from === 'session') {
      sources[dimension] = source;
      continue;
    }
    if (!inputHasPath(inputSchema, source.path, where)) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `${where}: the input has no ${['input', ...source.path].join('.')}`,
        'Point the scope at the input field that holds the key, e.g. { org: "input.orgId" }.',
      );
    }
    sources[dimension] = { from: 'input', path: source.path, kind };
  }
  return sources;
}

/**
 * The app's live manifest: every procedure of `contract` (nested routers
 * included) whose meta declares `live`, with its path, the tables it reads and
 * its scope. A procedure without `live` meta is not live and is left out.
 * Walks the contract once; build it at boot, not per request.
 *
 * Throws E001 for live meta that does not parse (hand-written, or from
 * another `@arki/live` version), a scope dimension `scopes` does not declare,
 * an input path the procedure's input schema does not have, and a manifest
 * past its bounds (4096 procedures, 32 path segments).
 */
export function liveManifest(contract: AnyContractRouter, options?: { readonly scopes?: LiveScopes }): LiveManifest {
  const { kinds } = checkScopes(options?.scopes, 'liveManifest()');
  const entries: LiveManifest = [];
  // A contract router is never lazy, so the walk has no lazy parts to return.
  traverseContractProcedures({ router: contract, path: [] }, ({ contract: procedure, path }) => {
    const live: unknown = procedure['~orpc'].meta.live;
    if (live === undefined) return;
    const parsed = liveMetaSchema.safeParse({ live });
    if (!parsed.success || parsed.data.live === undefined) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `liveManifest(): bad live meta on ${path.join('.')}: ${parsed.error?.message ?? 'empty'}`,
        'Build the meta with live({ reads: [...] }) from @arki/live/drizzle (or @arki/live): version 1 and 1 to 256 tables.',
      );
    }
    const { reads, scope } = parsed.data.live;
    entries.push(
      scope === undefined
        ? { path: [...path], reads }
        : { path: [...path], reads, scope: scopeOf(scope, kinds, procedure['~orpc'].inputSchema, path) },
    );
  });
  const manifest = liveManifestSchema.safeParse(entries);
  if (!manifest.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `liveManifest(): the manifest is out of bounds: ${manifest.error.message}`,
      'An app has at most 4096 live procedures, each at a path of 1 to 32 non-empty segments.',
    );
  }
  return manifest.data;
}
