/**
 * The HTTP response cache on Postgres: `@arki/http/idempotency` stores a finished response here and
 * replays it when the same `Idempotency-Key` comes again.
 *
 * This is NOT the command receipt. A command receipt (`idempotencyKey` on `journal.run`) commits in
 * the same transaction as the business write. A response cache row is written by the HTTP layer
 * after the response exists, so it can lose a race with a crash: the write happened and the row
 * did not. The two share the `journal_receipts` table and never share a key, because every
 * response cache key starts with `http:`.
 *
 * `@arki/http` is an optional peer. May import `pg` and `types` only.
 */
import { and, eq, gt, lte, sql } from 'drizzle-orm';

import type { BeginResult, ResponseCache } from '@arki/http/idempotency';
import { storedResponse } from '@arki/http/idempotency';
import { parse } from '@arki/schema';

import type { JournalTables } from './pg.js';
import type { DbHandle } from './types.js';

/** The expiry time for a ttl in milliseconds, by the database clock. */
const expiry = (ttl: number) => sql`now() + (${ttl}::double precision / 1000) * interval '1 second'`;

/** What marks a `journal_receipts` row as a response cache row. */
const COMMAND = 'http.response';
const KEY_PREFIX = 'http:';

/**
 * A {@link ResponseCache} on `journal_receipts`. Give it the root database (not a command's
 * transaction): each call is its own statement and commits on its own.
 *
 * - `begin` is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`. The row lock
 *   makes two concurrent first requests meet: one inserts, the other waits and then sees a live row.
 *   An expired row is taken over by the same statement. Expiry uses the database clock.
 * - `finish` and `abandon` only touch a row the caller owns. After expiry and reassignment, the old
 *   owner's call matches nothing.
 */
export function responseCache(db: DbHandle, tables: Pick<JournalTables, 'receipts'>): ResponseCache {
  const receipts = tables.receipts;
  return {
    async begin(key, fingerprint, owner, ttl): Promise<BeginResult> {
      const rowKey = KEY_PREFIX + key;
      // A row can expire or be freed between the insert and the read; the second round settles that.
      for (let round = 0; round < 3; round += 1) {
        const taken = await db
          .insert(receipts)
          .values({
            key: rowKey,
            command: COMMAND,
            input: fingerprint,
            commandId: owner,
            owner,
            expiresAt: expiry(ttl),
          })
          .onConflictDoUpdate({
            target: receipts.key,
            set: {
              input: fingerprint,
              commandId: owner,
              owner,
              expiresAt: expiry(ttl),
              response: null,
              recordedAt: sql`now()`,
            },
            setWhere: and(eq(receipts.command, COMMAND), lte(receipts.expiresAt, sql`now()`)),
          })
          .returning({ key: receipts.key });
        if (taken.length > 0) return 'started';

        const [held] = await db
          .select({ input: receipts.input, response: receipts.response })
          .from(receipts)
          .where(and(eq(receipts.key, rowKey), gt(receipts.expiresAt, sql`now()`)));
        if (held === undefined) continue;
        if (held.input !== fingerprint) return 'conflict';
        if (held.response === null) return 'in-progress';
        return { replay: parse(storedResponse, held.response) };
      }
      throw new Error(`journal: response cache key ${JSON.stringify(key)} kept changing while it was being claimed`);
    },

    async finish(key, owner, response) {
      await db
        .update(receipts)
        .set({ response })
        .where(and(eq(receipts.key, KEY_PREFIX + key), eq(receipts.owner, owner), gt(receipts.expiresAt, sql`now()`)));
    },

    async abandon(key, owner) {
      await db.delete(receipts).where(and(eq(receipts.key, KEY_PREFIX + key), eq(receipts.owner, owner)));
    },
  };
}
