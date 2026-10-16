/**
 * `pgSource`: the hub's source on a `pg` pool. One dedicated client `LISTEN`s
 * on the app's channel (`listenOnPool` from `@arki/db/pg`); each trigger
 * payload becomes a `change`. Anything that breaks continuity becomes a `gap`:
 * a lost connection, a failed health check, or a payload this version cannot
 * read (the hint inside is lost, so clients must reset).
 */
import { z } from 'zod';

import type { ListenPool } from '@arki/db/pg';
import { listenOnPool } from '@arki/db/pg';

import type { LiveSource } from '../hub.js';
import type { TableTag } from '../schema.js';
import { debugSource } from '../debug.js';
import { tableTagSchema, txIdSchema } from '../schema.js';
import { liveChannel } from './migration.js';

/** What the trigger and `touch` publish: the table, and the committing transaction's id in decimal. */
const hintSchema = z.object({ v: z.literal(1), tag: tableTagSchema, txid: txIdSchema }).strict();

/** @internal The tag and txid in a trigger payload, or `undefined` for anything else. */
export function parseHint(payload: string): { readonly tag: TableTag; readonly txid: string } | undefined {
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    return undefined;
  }
  const parsed = hintSchema.safeParse(json);
  return parsed.success ? { tag: parsed.data.tag, txid: parsed.data.txid } : undefined;
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
        if (hint) {
          receive({ kind: 'change', tags: [hint.tag], txid: hint.txid });
          return;
        }
        // Still listening, but one hint is unreadable: end every stream, start a new epoch.
        debugSource.debug('{channel}: unreadable payload; treated as a gap', { channel, bytes: payload.length });
        receive({ kind: 'gap' });
        receive({ kind: 'ready' });
      });
    },
  };
}
