/** A null send acknowledgement proves success only when its deterministic job exists. */
import { PGlite } from '@electric-sql/pglite';
import { PgBoss } from 'pg-boss';
import { expect, it, vi } from 'vitest';

import { z } from '@arki/contracts';

import { initQueue } from '../init.ts';
import { QueueAcceptanceUnknown } from '../errors.ts';
import { createRuntimeLocalQueueInstance } from './create-queue.ts';
import { pgBossJobId } from './identity.ts';

it.each(['missing', 'throws'] as const)(
  'does not fabricate acceptance when duplicate lookup %s',
  async lookup => {
    const db = new PGlite();
    const instance = createRuntimeLocalQueueInstance({ pglite: db, createContext: () => ({}) });
    const q = initQueue.context<Record<string, never>>().create();
    const job = q.job
      .name('unconfirmed-ack')
      .input(z.object({ n: z.number() }))
      .handler(() => Promise.resolve('done'));
    await instance.register({ job });
    await instance.start();
    const send = vi.spyOn(PgBoss.prototype, 'send').mockResolvedValue(null);
    const get = vi.spyOn(PgBoss.prototype, 'getJobById');
    if (lookup === 'missing') get.mockResolvedValue(null);
    else get.mockRejectedValue(new Error('lookup unavailable'));
    try {
      expect(await job.trigger({ n: 1 }, { jobId: 'external-key' })).toMatchObject({
        code: QueueAcceptanceUnknown.code,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledWith('unconfirmed-ack', pgBossJobId('unconfirmed-ack', 'external-key'));
      const stored = await db.query('select id from infra_pg_boss.job');
      expect(stored.rows).toEqual([]);
    } finally {
      send.mockRestore();
      get.mockRestore();
      await instance.stop();
      await db.close();
    }
  },
  20_000,
);
