/** Child process used only by the backend crash/recovery conformance test. */
import { appendFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';

import { orThrow } from '@arki/failure';

import type { BullMQQueueInstance } from './types/builder.ts';
import { initQueue } from './init.ts';
import { createRuntimeLocalQueueInstance } from './runtime-local/create-queue.ts';
import { pgBossJobId } from './runtime-local/identity.ts';

const config = z
  .object({
    QUEUE_BACKEND: z.enum(['bullmq', 'pg-boss']),
    QUEUE_MODE: z.enum(['crash', 'recover']),
    QUEUE_NAME: z.string(),
    QUEUE_JOB_ID: z.string().min(1),
    QUEUE_PREFIX: z.string(),
    QUEUE_REDIS_URL: z.string(),
    QUEUE_DB_PATH: z.string(),
    QUEUE_EFFECT_PATH: z.string(),
  })
  .parse(process.env);
const local = config.QUEUE_BACKEND === 'pg-boss' ? new PGlite(config.QUEUE_DB_PATH) : undefined;
const q = initQueue.context<Record<string, never>>().create();
const job = q.job
  .name(config.QUEUE_NAME)
  .input(z.object({ n: z.number() }))
  .options({ workerOptions: { lockDuration: 1000, stalledInterval: 500 }, runtimeLocalOptions: { expireInSeconds: 5 } })
  .handler(async (_input, ctx) => {
    await appendFile(config.QUEUE_EFFECT_PATH, `${ctx.job.id}\n`);
    if (config.QUEUE_MODE === 'crash') await local?.syncToFs();
    process.send?.({ status: 'active', id: ctx.job.id, attempt: ctx.job.attemptsMade });
    if (config.QUEUE_MODE === 'crash')
      await new Promise<void>(() => {
        /* The crash fixture deliberately waits for SIGKILL. */
      });
    return { done: true };
  });
let bull: BullMQQueueInstance | undefined;
const instance =
  local === undefined
    ? (bull = q.createQueue({
        connection: config.QUEUE_REDIS_URL,
        keyPrefix: config.QUEUE_PREFIX,
        createContext: () => ({}),
      }))
    : createRuntimeLocalQueueInstance({
        pglite: local,
        createContext: () => ({}),
        superviseIntervalSeconds: 1,
        maintenanceIntervalSeconds: 1,
        monitorIntervalSeconds: 1,
      });
await instance.register({ job });
await instance.start();
if (config.QUEUE_MODE === 'crash') orThrow(await job.trigger({ n: 1 }, { jobId: config.QUEUE_JOB_ID }));
if (config.QUEUE_MODE === 'recover') {
  const deadline = Date.now() + 20_000;
  let completed = false;
  while (Date.now() < deadline) {
    if (bull !== undefined) {
      completed = (await bull.queues().get(config.QUEUE_NAME)?.getJobState(config.QUEUE_JOB_ID)) === 'completed';
    } else if (local !== undefined) {
      const rows = await local.query(`select id from infra_pg_boss.job where id = $1 and state = 'completed'`, [
        pgBossJobId(config.QUEUE_NAME, config.QUEUE_JOB_ID),
      ]);
      completed = rows.rows.length === 1;
    }
    if (completed) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!completed) throw new Error('Restart did not recover the delivery');
  const duplicate = orThrow(await job.trigger({ n: 1 }, { jobId: config.QUEUE_JOB_ID }));
  if (duplicate !== config.QUEUE_JOB_ID) throw new Error('The external key changed after restart.');
  await new Promise(resolve => setTimeout(resolve, 600));
  process.send?.({ status: 'completed', id: config.QUEUE_JOB_ID });
  await instance.stop();
  await local?.close();
  process.disconnect?.();
}
