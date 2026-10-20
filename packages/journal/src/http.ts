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
import { and, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';

import type { ResponseCache } from '@arki/http/idempotency';
import { isFailure } from '@arki/failure';
import {
  IdempotencyClaimUnconfirmed,
  IdempotencyOwnershipLost,
  IdempotencyReleaseUnconfirmed,
  IdempotencyReplayInvalid,
  IdempotencyWriteUnconfirmed,
  storedResponse,
} from '@arki/http/idempotency';
import { parse } from '@arki/schema';

import type { JournalTables } from './pg.js';
import type { DbHandle } from './types.js';

/** The expiry time for replay retention in milliseconds, by the database clock. */
const expiry = (ttl: number) => sql`now() + (${ttl}::double precision / 1000) * interval '1 second'`;
const COMMAND = 'http.response';
const KEY_PREFIX = 'http:';

/**
 * A response cache on the root database. Unresolved reservations never expire. Only a completed,
 * expired replay can be taken over; finish atomically checks ownership and starts retention.
 */
export function responseCache(db: DbHandle, tables: Pick<JournalTables, 'receipts'>): ResponseCache {
  const receipts = tables.receipts;
  return {
    async begin(key, fingerprint, owner) {
      const rowKey = KEY_PREFIX + key;
      try {
        // A completed replay can expire, or a reconciled claim can be released, between statements.
        for (let round = 0; round < 3; round += 1) {
          const taken = await db
            .insert(receipts)
            .values({ key: rowKey, command: COMMAND, input: fingerprint, commandId: owner, owner })
            .onConflictDoUpdate({
              target: receipts.key,
              set: {
                input: fingerprint,
                commandId: owner,
                owner,
                expiresAt: null,
                response: null,
                recordedAt: sql`now()`,
              },
              setWhere: and(
                eq(receipts.command, COMMAND),
                isNotNull(receipts.response),
                lte(receipts.expiresAt, sql`now()`),
              ),
            })
            .returning({ key: receipts.key });
          if (taken.length === 1 && taken[0]?.key === rowKey) return 'started';
          if (taken.length > 0) return IdempotencyClaimUnconfirmed();

          const held = await db
            .select({
              command: receipts.command,
              input: receipts.input,
              response: receipts.response,
              owner: receipts.owner,
            })
            .from(receipts)
            .where(and(eq(receipts.key, rowKey), or(isNull(receipts.response), gt(receipts.expiresAt, sql`now()`))));
          if (held.length === 0) continue;
          const row = held[0];
          if (
            held.length !== 1 ||
            row?.command !== COMMAND ||
            typeof row.input !== 'string' ||
            typeof row.owner !== 'string'
          )
            return IdempotencyClaimUnconfirmed();
          if (row.input !== fingerprint) return 'conflict';
          if (row.response === null) return 'in-progress';
          try {
            const replay = parse(storedResponse, row.response);
            if (isFailure(replay)) return IdempotencyReplayInvalid({ cause: replay });
            return { replay };
          } catch (error) {
            return IdempotencyReplayInvalid({ cause: error });
          }
        }
        return IdempotencyClaimUnconfirmed();
      } catch (error) {
        return IdempotencyClaimUnconfirmed({ cause: error });
      }
    },

    async finish(key, owner, response, ttl) {
      if (!Number.isSafeInteger(ttl) || ttl <= 0) return IdempotencyWriteUnconfirmed();
      try {
        const updated = await db
          .update(receipts)
          .set({ response, expiresAt: expiry(ttl) })
          .where(and(eq(receipts.command, COMMAND), eq(receipts.key, KEY_PREFIX + key), eq(receipts.owner, owner)))
          .returning({ key: receipts.key });
        if (updated.length === 0) return IdempotencyOwnershipLost();
        if (updated.length !== 1 || updated[0]?.key !== KEY_PREFIX + key) return IdempotencyWriteUnconfirmed();
      } catch (error) {
        return IdempotencyWriteUnconfirmed({ cause: error });
      }
      return;
    },

    async abandon(key, owner) {
      try {
        const deleted = await db
          .delete(receipts)
          .where(
            and(
              eq(receipts.command, COMMAND),
              eq(receipts.key, KEY_PREFIX + key),
              eq(receipts.owner, owner),
              isNull(receipts.response),
            ),
          )
          .returning({ key: receipts.key });
        if (deleted.length > 1 || (deleted.length === 1 && deleted[0]?.key !== KEY_PREFIX + key))
          return IdempotencyReleaseUnconfirmed();
      } catch (error) {
        return IdempotencyReleaseUnconfirmed({ cause: error });
      }
      return;
    },
  };
}
