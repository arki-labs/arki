/**
 * `@arki/live/dot` (peer `@arki/dot`): `liveQueries`, the Dot plugin that runs
 * live queries for an app.
 *
 * - Declaration: the manifest is read from the contract once (E001 on bad meta).
 * - `boot`: `verifyLiveTriggers` on every manifest table; any problem fails
 *   boot with E002, before anything listens.
 * - `start`: the hub `LISTEN`s on its own pool. Declare the plugin after
 *   `dbMigrations` and before `http()`, so it listens before ingress opens.
 * - `stop`: every stream gets `bye`, `UNLISTEN`, the client goes back to the
 *   pool (the pool itself is the caller's). The kernel also runs it when a
 *   later plugin fails to start, so that rollback leaves nothing held. Boot
 *   takes nothing to release: the listener connects only at start.
 *
 * Publishes `live` (the hub) and `liveRoutes` (the `GET /api/live` bundle,
 * for `http({ bundles: [liveQ.provides.liveRoutes] })`).
 */
import type { AnyContractRouter } from '@orpc/contract';
import type { SQL } from 'drizzle-orm';

import type { ListenPool } from '@arki/db/pg';
import type { CtxOf, NeedsShape, NoReservedKeys } from '@arki/dot/plugin';
import { plugin } from '@arki/dot/plugin';

import type { LiveGrant } from './http.js';
import type { LiveHub, LiveLimits } from './hub.js';
import type { LiveReceipts } from './receipts.js';
import { debugDot } from './debug.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { liveEndpoint } from './http.js';
import { createLiveHub } from './hub.js';
import { liveTables } from './manifest.js';
import { liveManifest } from './orpc/manifest.js';
import { pgSource } from './pg/source.js';
import { verifyLiveTriggers } from './pg/verify.js';

export function liveQueries<Needs extends NeedsShape & NoReservedKeys>(options: {
  /** The app's name: the trigger channel and trigger name derive from it. */
  readonly app: string;
  /** Must give a database for the boot check. */
  readonly needs: Needs;
  readonly db: (ctx: CtxOf<Needs>) => { execute(query: SQL): Promise<unknown> };
  /** The listener's pool. A separate 1-connection pool is advised: the listener holds its client while it runs. */
  readonly pool: (ctx: CtxOf<Needs>) => ListenPool;
  /** The app's contract: every procedure with `live` meta is in the manifest. */
  readonly contract: AnyContractRouter;
  readonly authorize: (request: Request) => Promise<LiveGrant | null>;
  readonly limits?: LiveLimits;
  readonly maxAgeMs?: number;
  /**
   * Frames name the receipts of their transactions, for `awaitTxId`: `liveReceipts({ app, secret })`
   * with the secret from the app config. Mutations return `receipts.of(txid)` from the same object.
   * Omitted: frames name none.
   */
  readonly receipts?: LiveReceipts;
}) {
  const manifest = liveManifest(options.contract);
  const tables = liveTables(manifest);
  /** The hub of the current boot: `live` makes it, `liveRoutes` (the next factory, in key order) serves it. */
  let booted: LiveHub | undefined;

  return plugin({
    name: 'live',
    needs: options.needs,
    provides: {
      live: ctx => {
        booted = createLiveHub({
          source: pgSource({ pool: options.pool(ctx), app: options.app }),
          ...(options.limits === undefined ? {} : { limits: options.limits }),
          ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
        });
        return booted;
      },
      liveRoutes: () => {
        const hub = booted;
        booted = undefined;
        if (hub === undefined) {
          throw liveError(
            LIVE_ERROR_CODES.config,
            'liveQueries(): liveRoutes was built before live',
            'The Dot kernel runs provides factories in key order; this @arki/dot does not. Report it.',
          );
        }
        return liveEndpoint({
          hub,
          manifest,
          authorize: options.authorize,
          ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
        }).routes;
      },
    },
    async boot(ctx) {
      const problems = await verifyLiveTriggers(options.db(ctx), { app: options.app, tables });
      if (problems.length > 0) {
        const list = problems.map(({ tag, problem }) => `${tag.schema}.${tag.table} (${problem})`).join(', ');
        throw liveError(
          LIVE_ERROR_CODES.triggers,
          `liveQueries(): ${problems.length} declared table(s) would never publish a hint: ${list}`,
          'Generate the triggers with liveMigration({ app, tables: liveTables(manifest) }) from @arki/live/pg and run the migration before boot; publish views with touch().',
        );
      }
      debugDot.debug('{app}: triggers verified on {tables} tables, {procedures} live procedures', {
        app: options.app,
        tables: tables.length,
        procedures: manifest.length,
      });
    },
    async start({ live }) {
      await live.start();
    },
    async stop({ live }) {
      await live.stop();
    },
  });
}
