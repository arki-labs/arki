// #region recover
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { orThrow } from '@arki/failure';
import { createRuntimeLocalQueueInstance, initQueue } from '@arki/queue/runtime-local';

const q = initQueue.context<Record<string, never>>().create();
const finished = Promise.withResolvers<void>();

const ship = q.job
  .name('orders.ship')
  .input(z.object({ orderId: z.string() }))
  // A claim that is not settled within 1 second means the worker is dead.
  .options({ runtimeLocalOptions: { expireInSeconds: 1 } })
  .handler(async (data, ctx) => {
    const attempt = ctx.job.attemptsMade + 1;
    console.log(`claimed ${data.orderId}, attempt ${attempt}`);
    // The first claim never settles, like a worker killed in the middle of the job.
    if (attempt === 1) await new Promise<never>(() => {});
    console.log(`shipped ${data.orderId}`);
    finished.resolve();
    return { shipped: true };
  });

const queue = createRuntimeLocalQueueInstance({
  pglite: new PGlite(),
  createContext: () => ({}),
  // Look for dead claims every second. The default is every 60 seconds.
  superviseIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
});
await queue.register({ ship });
await queue.start();
orThrow(await ship.trigger({ orderId: 'ord_1' }));
await finished.promise;
// The first handler never settles, so a graceful stop would wait for it. Exit instead.
process.exit(0);
// #endregion recover
