/**
 * `@arki/dot` adapter. Publishes the journal as `services.journal` and runs one
 * worker per process between `start` and `stop`. The app's `db` plugin must
 * publish a Drizzle handle under the `db` key.
 *
 * `@arki/dot` is an optional peer. Import this module only inside a DOT app.
 */
import type { z } from 'zod';

import { plugin, service } from '@arki/dot/plugin';

import type { Journal } from './journal.js';
import type { Db, Worker } from './types.js';

export function journalPlugin<Meta extends z.ZodObject>(options: {
  readonly journal: Journal<Meta>;
  /** Run the async lane in this process. Default `true`. */
  readonly worker?: boolean;
  readonly pollMs?: number;
  readonly limit?: number;
}) {
  let worker: Worker | undefined;
  return plugin({
    name: 'journal',
    needs: { db: service<Db>() },
    boot() {
      return { journal: options.journal };
    },
    async start({ db }) {
      if (options.worker === false) return;
      worker = options.journal.worker(db, { pollMs: options.pollMs, limit: options.limit });
      await worker.start();
    },
    async stop() {
      await worker?.stop();
      worker = undefined;
    },
  });
}
