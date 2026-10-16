/**
 * `pgSource`: the hub's source on a `pg` pool. One dedicated client `LISTEN`s
 * on the app's channel (`listenOnPool` from `@arki/db/pg`); each trigger
 * payload becomes a `change`. Anything that breaks continuity becomes a `gap`:
 * a lost connection, a failed health check, a payload this version cannot
 * read, or an overflow (a statement changed more keys than one hint names):
 * the hint inside is lost, so clients must reset.
 */
import { z } from 'zod';

import type { ListenPool } from '@arki/db/pg';
import { listenOnPool } from '@arki/db/pg';

import type { LiveSource } from '../hub.js';
import type { TableTag } from '../types.js';
import { debugSource } from '../debug.js';
import { tagKey } from '../manifest.js';
import { scopeKeySchema, tableTagSchema, txIdSchema } from '../schema.js';
import { liveChannel } from './migration.js';

/**
 * What the triggers and `touch` publish: the table and the committing transaction's id in
 * decimal; on a scoped table also one changed key, or `overflow` when a statement changed too
 * many keys (or one too long) to name.
 */
const hintSchema = z.union([
  z.object({ v: z.literal(1), tag: tableTagSchema, txid: txIdSchema }).strict(),
  z.object({ v: z.literal(1), tag: tableTagSchema, txid: txIdSchema, key: scopeKeySchema }).strict(),
  z.object({ v: z.literal(1), tag: tableTagSchema, txid: txIdSchema, overflow: z.literal(true) }).strict(),
]);

/** @internal A trigger payload: a hint (with its key on a scoped table), an overflow, or `undefined` for anything else. */
export function parseHint(
  payload: string,
):
  | { readonly tag: TableTag; readonly txid: string; readonly key?: string }
  | { readonly tag: TableTag; readonly txid: string; readonly overflow: true }
  | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = hintSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { tag, txid } = parsed.data;
  if ('overflow' in parsed.data) return { tag, txid, overflow: true };
  return 'key' in parsed.data ? { tag, txid, key: parsed.data.key } : { tag, txid };
}

/**
 * `createLiveHub({ source: pgSource({ pool: listenPool, app: 'blog' }) })`. Give it a pool
 * of its own (one client is enough), apart from the app's query pool: the listener holds
 * its client for as long as it runs. The hub is `ready` only once `LISTEN` succeeded, and
 * again, with a new epoch, after every reconnect.
 */
export function pgSource(options: {
  readonly pool: ListenPool;
  readonly app: string;
  readonly retryMs?: number;
  readonly healthMs?: number;
}): LiveSource {
  const channel = liveChannel(options.app);
  return {
    start(receive) {
      const listen = listenOnPool(options.pool, channel, {
        retryMs: options.retryMs,
        healthMs: options.healthMs,
        onState: state => receive({ kind: state === 'ready' ? 'ready' : 'gap' }),
      });
      return listen(payload => {
        const hint = parseHint(payload);
        if (hint && !('overflow' in hint)) {
          const { tag, txid, key } = hint;
          receive({ kind: 'change', tags: [key === undefined ? tag : { ...tag, keys: [key] }], txid });
          return;
        }
        // Still listening, but a hint is lost: unreadable, or a statement changed more keys than a
        // hint names. End every stream and start a new epoch: every client resets, which covers it.
        if (hint) {
          debugSource.warn('{channel}: a statement on {table} changed too many keys to name; every client resets', {
            channel,
            table: tagKey(hint.tag),
          });
        } else {
          debugSource.debug('{channel}: unreadable payload; treated as a gap', { channel, bytes: payload.length });
        }
        receive({ kind: 'gap' });
        receive({ kind: 'ready' });
      });
    },
  };
}
