import type { AnyContractRouter } from '@orpc/contract';
import { traverseContractProcedures } from '@orpc/server';

import type { LiveManifest } from '../types.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { liveManifestSchema, liveMetaSchema } from '../schema.js';

/**
 * The app's live manifest: every procedure of `contract` (nested routers
 * included) whose meta declares `live`, with its path and the tables it reads.
 * A procedure without `live` meta is not live and is left out. Walks the
 * contract once; build it at boot, not per request.
 *
 * Throws E001 for live meta that does not parse (hand-written, or from
 * another `@arki/live` version) and for a manifest past its bounds (4096
 * procedures, 32 path segments).
 */
export function liveManifest(contract: AnyContractRouter): LiveManifest {
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
    entries.push({ path: [...path], reads: parsed.data.live.reads });
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
