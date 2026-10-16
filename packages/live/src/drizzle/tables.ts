import type { PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig } from 'drizzle-orm/pg-core';

import type { LiveMeta, TableTag } from '../types.js';
import { live as liveFromTags } from '../manifest.js';

/**
 * The tag of a Drizzle table. `table._` exists in the types only, so the name
 * and schema are read with `getTableConfig`; `pgTable` has no schema, which
 * Postgres calls `public`.
 */
export function tableTag(table: PgTable): TableTag {
  const { name, schema } = getTableConfig(table);
  return { schema: schema ?? 'public', table: name };
}

/**
 * Contract meta from the Drizzle tables a procedure reads: plain JSON, deduplicated. `scope` maps
 * a dimension of `liveScopes` to where the procedure's key comes from (`'input.orgId'`, `'session'`).
 */
export function live(
  options: { readonly reads: readonly PgTable[] } & Pick<Parameters<typeof liveFromTags>[0], 'scope'>,
): Required<LiveMeta> {
  return liveFromTags({ ...options, reads: options.reads.map(table => tableTag(table)) });
}
