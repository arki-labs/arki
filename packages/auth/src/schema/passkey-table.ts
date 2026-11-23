import type { Column } from 'drizzle-orm';

import type { AnyColumnSpec, ColumnKit, Dialect } from '@arki/db/columns';

import type { AuthColumnFill, AuthColumnOptions, PrimaryColumnSource } from './column-options.js';
import { columnNamer, filledAt } from './column-options.js';

export type CreatePasskeyTablesOptions<
  D extends Dialect,
  TPasskeyId extends AnyColumnSpec<D>,
  TFill extends AuthColumnFill,
> = AuthColumnOptions<TFill> & {
  /** The app's `User` table. A passkey points at its `id` and goes away with the user. */
  user: { id: Column };
  /** The app's id source for the passkey table, e.g. `authIdSources` (its `passkey` key). The lib never makes ids. */
  ids: { passkey: PrimaryColumnSource<TPasskeyId> };
};

/**
 * The `passkeys` table the passkey sign-in needs, written once against the column kit. Build it
 * only when the definition lists `passkey`, and pass it with the other tables:
 * `tables: { ...authTables, ...passkeyTables }`.
 *
 * Column keys mirror the engine's passkey model fields (`credentialID`, `publicKey`, `counter`, …),
 * because the Drizzle adapter maps each field to the identically-named column.
 *
 * @example
 * ```typescript
 * export const passkeyTables = createPasskeyTables(c, { fill: 'app', user: authTables.User, ids: authIdSources });
 * ```
 */
export function createPasskeyTables<
  D extends Dialect,
  TPasskeyId extends AnyColumnSpec<D>,
  TFill extends AuthColumnFill,
>(c: ColumnKit<D>, { naming, fill, user, ids }: CreatePasskeyTablesOptions<D, TPasskeyId, TFill>) {
  const name = columnNamer(naming);

  const Passkey = c.table(
    'passkeys',
    {
      id: ids.passkey.primaryColumn(),
      /** The label the user gave the passkey, if any. */
      name: c.text(name('name')),
      publicKey: c.text(name('publicKey')).notNull(),
      userId: c
        .text(name('userId'))
        .notNull()
        .references(() => user.id, { onDelete: 'cascade' }),
      credentialID: c.text(name('credentialID')).notNull(),
      /** The authenticator's signature counter; a counter that goes back means a cloned key. */
      counter: c.integer(name('counter')).notNull(),
      deviceType: c.text(name('deviceType')).notNull(),
      backedUp: c.boolean(name('backedUp')).notNull(),
      transports: c.text(name('transports')),
      createdAt: filledAt(c)(fill, name('createdAt')),
      aaguid: c.text(name('aaguid')),
    },
    table => [
      c.index('passkeys_user_id_idx').on(table.userId),
      c.uniqueIndex('passkeys_credential_id_idx').on(table.credentialID),
    ],
  );

  return { Passkey };
}
