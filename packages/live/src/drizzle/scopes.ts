import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { getColumnTable } from 'drizzle-orm';

import type { LiveKeyKind, LiveScopedTable, LiveScopes } from '../types.js';
import { LIVE_ERROR_CODES, liveError } from '../errors.js';
import { checkScopes } from '../scopes.js';
import { tableTag } from './tables.js';

/** A scope column: NOT NULL, so every row has a key (a NULL one would hide its change from `'all'` readers). */
type ScopeColumn = PgColumn & { readonly _: { readonly notNull: true } };

/**
 * The key kind of a column, from its SQL type: `uuid`; `text` or `varchar` (compared exactly);
 * any integer type. `undefined` for the rest: `char` pads with spaces, `citext` ignores case, and
 * other types print in more than one way.
 */
function kindOf(column: PgColumn): LiveKeyKind | undefined {
  const type = column.getSQLType();
  if (type === 'uuid') return 'uuid';
  if (type === 'text' || /^varchar(?:\(\d+\))?$/.test(type)) return 'text';
  if (/^(?:smallint|integer|bigint|smallserial|serial|bigserial)$/.test(type)) return 'int';
  return undefined;
}

/**
 * Declares which tables are scoped, by which dimension and key column: one object, read by the
 * migration, `verifyLiveTriggers`, `liveManifest` and the endpoint. Dimension names come from the
 * keys; the key kind from each column's type. A table has one dimension; one dimension has one key
 * kind; every column is NOT NULL and belongs to its table (E001 otherwise).
 *
 *   const scopes = liveScopes({ org: [[posts, posts.orgId], [likes, likes.orgId]], user: [[memberships, memberships.userId]] });
 */
export function liveScopes<Dimension extends string>(
  declaration: Readonly<Record<Dimension, readonly (readonly [PgTable, ScopeColumn])[]>>,
): LiveScopes<Dimension> {
  const dimensions = Object.keys(declaration).filter((name): name is Dimension => Object.hasOwn(declaration, name));
  const tables: LiveScopedTable<Dimension>[] = [];
  for (const dimension of dimensions) {
    for (const [table, column] of declaration[dimension]) {
      const tag = tableTag(table);
      const where = `liveScopes(): ${dimension}: ${tag.schema}.${tag.table}.${column.name}`;
      if (getColumnTable(column) !== table) {
        throw liveError(
          LIVE_ERROR_CODES.config,
          `${where} is not a column of that table`,
          'Pair each table with its own column: [posts, posts.orgId].',
        );
      }
      if (!column.notNull) {
        throw liveError(
          LIVE_ERROR_CODES.config,
          `${where} is nullable`,
          'Make the scope column NOT NULL: a row without a key would hide its change from readers granted every key.',
        );
      }
      const kind = kindOf(column);
      if (kind === undefined) {
        throw liveError(
          LIVE_ERROR_CODES.config,
          `${where} is ${column.getSQLType()}, not a scope key type`,
          'A scope column is uuid, text, varchar or an integer type.',
        );
      }
      tables.push({ tag, dimension, column: column.name, kind });
    }
  }
  const scopes: LiveScopes<Dimension> = { dimensions, tables };
  checkScopes(scopes, 'liveScopes()');
  return scopes;
}
