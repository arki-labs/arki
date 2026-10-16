import type { LiveManifest, LiveMeta, TableTag } from './schema.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tableTagSchema } from './schema.js';

/** A stable key for one table: identifiers may hold dots, so the pair is encoded, not joined. */
export function tagKey(tag: TableTag): string {
  return JSON.stringify([tag.schema, tag.table]);
}

/** Contract meta from tags, deduplicated, in declaration order. `@arki/live/drizzle` has the table form most apps use. */
export function live(options: { readonly reads: readonly TableTag[] }): Required<LiveMeta> {
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
  return { live: { version: 1, reads: [...reads.values()] } };
}

/** The paths whose declared reads include any of `tags`. Pure. */
export function affectedPaths(manifest: LiveManifest, tags: readonly TableTag[]): readonly (readonly string[])[] {
  const changed = new Set(tags.map(tag => tagKey(tag)));
  return manifest.filter(entry => entry.reads.some(read => changed.has(tagKey(read)))).map(entry => entry.path);
}
