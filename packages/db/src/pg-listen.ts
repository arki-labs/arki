/**
 * `listenOnPool`: hear one Postgres `NOTIFY` channel on a dedicated client of a
 * `pg` pool. The journal's worker wakes on it; `@arki/live/pg` turns it into
 * live-query hints.
 *
 * The client is borrowed for as long as the listener runs. It is lost on an
 * `error`, an `end`, or a health check that gets no answer within `healthMs`;
 * then it is released once (destroyed, never reused), `onState('disconnected')`
 * runs, and a new client is tried every `retryMs` until `LISTEN` succeeds again
 * (`onState('ready')`). Notifications sent while no client listens are lost:
 * a caller that cares (live queries do) treats `disconnected` as a gap.
 *
 * Typed by shape, so this file imports no driver.
 */
import { defineFailure, UnexpectedFailure } from '@arki/failure';
import { getLogger } from '@arki/log';

import { observeDbOperation } from './runtime-local-telemetry.js';
import { unrefTimer } from './timers.js';

/** Enable with `DEBUG=arki:db:listen`. */
const debugListen = getLogger('arki:db:listen');

/** The part of a `pg` pool client a listener uses. */
export type ListenClient = {
  query(text: string): Promise<unknown>;
  on(
    event: 'notification',
    listener: (message: { readonly channel: string; readonly payload?: string }) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  release(error?: Error | boolean): void;
};

/** The part of a `pg` pool a listener uses: `new pg.Pool(...)`, or a Drizzle node-postgres database's `$client`. */
export type ListenPool = { connect(): Promise<ListenClient> };

export type ListenOptions = {
  /** Wait between reconnect attempts, in milliseconds. Default 1000. */
  readonly retryMs?: number;
  /** Every `healthMs` the client runs `select 1`; no answer by the next check means the connection is lost. Default 5000. */
  readonly healthMs?: number;
  /** `ready` after every successful `LISTEN` (the first one included); `disconnected` when the client is lost. Not called after stop. */
  readonly onState?: (state: 'ready' | 'disconnected') => void;
};

/**
 * The first connection or `LISTEN` of a listener failed (no free client, permission denied, no `LISTEN` support).
 * Nothing retries: the start rejects with an `UnexpectedFailure` whose `failure` is this value and whose
 * `cause` is the raw pool error. (`WakeListener` in `@arki/journal` is `Unlisten | Promise<Unlisten>`, so the
 * start cannot return a failure without changing that contract.)
 * @fix Check the pool, the credentials and that the server supports `LISTEN`, then start the listener again.
 * @verify bun run test -- src/pg-listen.test.ts
 */
export const ListenUnavailable = defineFailure('db.listen_unavailable', {
  status: 503,
  message: 'The Postgres listener could not start.',
  remediation: 'Inspect the private cause: check the pool, the credentials and that the server supports LISTEN.',
});

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`listenOnPool(): ${name} must be a positive number of milliseconds, got ${value}`);
  }
  return value;
}

/**
 * Hear `channel` on a dedicated client of `pool`. It resolves with the function that
 * stops it, the shape of the journal's `WakeListener`:
 * `journal.worker(db, { listen: listenOnPool(listenPool, journal.wakeChannel) })`.
 * The first connection is made when listening starts; if it fails, the start rejects.
 * Stop closes the client instead of handing it back: its handlers stay on it, and a
 * reused client would run them for a stopped listener.
 */
export function listenOnPool(
  pool: ListenPool,
  channel: string,
  options?: ListenOptions,
): (onMessage: (payload: string) => void) => Promise<() => Promise<void>> {
  const retryMs = positive('retryMs', options?.retryMs ?? 1000);
  const healthMs = positive('healthMs', options?.healthMs ?? 5000);
  const onState = options?.onState;
  const quoted = `"${channel.replaceAll('"', '""')}"`;

  /** A state observer is the caller's code: if it throws, the listener goes on and the throw is only logged. */
  const notify = (state: 'ready' | 'disconnected'): void => {
    try {
      onState?.(state);
    } catch (error) {
      debugListen.debug('{channel}: onState({state}) threw: {reason}', { channel, state, reason: toError(error).message });
    }
  };

  return onMessage => observeDbOperation('db.listen.start', async () => {
    let stopped = false;
    let current: { readonly client: ListenClient; readonly drop: (error?: Error) => boolean } | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const schedule = (): void => {
      if (stopped || retry !== undefined) return;
      retry = setTimeout(() => {
        retry = undefined;
        connect().catch((error: unknown) => {
          debugListen.debug('{channel}: reconnect failed: {reason}', { channel, reason: toError(error).message });
          schedule();
        });
      }, retryMs);
      unrefTimer(retry);
    };

    const connect = async (): Promise<void> => {
      const client = await pool.connect();
      /** Read by the handlers and after awaits, so a field rather than a narrowed local. */
      const clientState: { released: boolean; health?: ReturnType<typeof setInterval> } = { released: false };

      /** Releases the client the first time only; true when this call did it. */
      const drop = (error?: Error): boolean => {
        if (clientState.released) return false;
        clientState.released = true;
        if (clientState.health !== undefined) clearInterval(clientState.health);
        if (current?.client === client) current = undefined;
        client.release(error ?? true);
        return true;
      };

      /** The connection died. Only a client that finished `LISTEN` reports it; during `connect()` the failing query does. */
      const lost = (error: Error): void => {
        const wasListening = current?.client === client;
        if (!drop(error) || !wasListening || stopped) return;
        debugListen.debug('{channel}: connection lost: {reason}', { channel, reason: error.message });
        notify('disconnected');
        schedule();
      };

      // Fenced: a released client forwards nothing, even if its socket still delivers.
      client.on('notification', message => {
        if (!clientState.released && !stopped && message.channel === channel && message.payload !== undefined) {
          onMessage(message.payload);
        }
      });
      client.on('error', lost);
      client.on('end', () => lost(new Error('the listen connection ended')));

      try {
        await client.query(`LISTEN ${quoted}`);
      } catch (error) {
        drop(toError(error));
        throw error;
      }
      if (clientState.released) throw new Error(`listen ${channel}: the connection was lost during LISTEN`);
      if (stopped) {
        drop();
        return;
      }
      current = { client, drop };

      let checking = false;
      clientState.health = setInterval(() => {
        if (checking) {
          lost(new Error(`no answer to the health check within ${healthMs} ms`));
          return;
        }
        checking = true;
        client.query('select 1').then(
          () => {
            checking = false;
          },
          (error: unknown) => lost(toError(error)),
        );
      }, healthMs);
      unrefTimer(clientState.health);

      debugListen.debug('{channel}: listening', { channel });
      notify('ready');
    };

    try {
      await connect();
    } catch (error) {
      throw new UnexpectedFailure(ListenUnavailable({ cause: error }));
    }
    return async () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      retry = undefined;
      const held = current;
      current = undefined;
      if (held === undefined) return;
      try {
        await held.client.query(`UNLISTEN ${quoted}`);
        held.drop();
      } catch (error) {
        held.drop(toError(error));
      }
      debugListen.debug('{channel}: stopped', { channel });
    };
  });
}
