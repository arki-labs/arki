import type { LiveManifest, LiveMeta, TableTag } from './types.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { dimensionSchema, tableTagSchema } from './schema.js';

/** A stable key for one table: identifiers may hold dots, so the pair is encoded, not joined. */
export function tagKey(tag: TableTag): string {
  return JSON.stringify([tag.schema, tag.table]);
}

/**
 * Where each scope key of a procedure comes from, by dimension: `'input.orgId'` (a path into its
 * input; `'input'` is the input itself) or `'session'` (any key the stream is granted).
 */
type ScopeOption = Readonly<Record<string, 'session' | 'input' | `input.${string}`>>;

type MetaScope = NonNullable<NonNullable<LiveMeta['live']>['scope']>;

function scopeOf(scope: ScopeOption): MetaScope {
  const sources: MetaScope = {};
  for (const [dimension, from] of Object.entries(scope)) {
    const path = from === 'session' ? undefined : from === 'input' ? [] : from.slice('input.'.length).split('.');
    const bad =
      !dimensionSchema.safeParse(dimension).success ||
      (from !== 'session' && from !== 'input' && !from.startsWith('input.')) ||
      (path !== undefined && (path.includes('') || path.length > 16));
    if (bad) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `live(): bad scope ${JSON.stringify({ [dimension]: from })}`,
        "Map a dimension name ([A-Za-z_][A-Za-z0-9_]*) to 'session', 'input' or 'input.path.to.key' (at most 16 segments).",
      );
    }
    sources[dimension] = path === undefined ? { from: 'session' } : { from: 'input', path };
  }
  return sources;
}

/**
 * Contract meta from tags, deduplicated, in declaration order, and the procedure's scope:
 * `scope: { org: 'input.orgId' }` refetches only the queries whose input holds a changed key;
 * `'session'` refetches the path on any key the stream is granted. `@arki/live/drizzle` has the
 * table form most apps use.
 */
export function live(options: {
  readonly reads: readonly TableTag[];
  readonly scope?: ScopeOption;
}): Required<LiveMeta> {
  const reads = new Map<string, TableTag>();
  for (const read of options.reads) {
    const parsed = tableTagSchema.safeParse(read);
    if (!parsed.success) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `live(): bad table tag ${JSON.stringify(read)}: ${parsed.error.message}`,
        'Pass { schema, table } with non-empty names of at most 63 bytes, or use live() from @arki/live/drizzle with Drizzle tables.',
      );
    }
    reads.set(tagKey(parsed.data), parsed.data);
  }
  if (reads.size === 0 || reads.size > 256) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `live(): a live procedure reads 1 to 256 tables, got ${reads.size}`,
      'List every table the procedure reads, and only those.',
    );
  }
  const meta = { version: 1 as const, reads: [...reads.values()] };
  return { live: options.scope === undefined ? meta : { ...meta, scope: scopeOf(options.scope) } };
}

/** Every table the manifest reads, once each, in first-seen order. Feeds `liveMigration` and `verifyLiveTriggers`. */
export function liveTables(manifest: LiveManifest): readonly TableTag[] {
  const tables = new Map<string, TableTag>();
  for (const entry of manifest) for (const read of entry.reads) tables.set(tagKey(read), read);
  return [...tables.values()];
}

/** The paths whose declared reads include any of `tags`. Pure. */
export function affectedPaths(manifest: LiveManifest, tags: readonly TableTag[]): readonly (readonly string[])[] {
  const changed = new Set(tags.map(tag => tagKey(tag)));
  return manifest.filter(entry => entry.reads.some(read => changed.has(tagKey(read)))).map(entry => entry.path);
}
