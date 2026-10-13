/**
 * `@arki/queue` implements the durable-schedule port without depending on
 * `@arki/schedule` (it restates the port's shape, so the queue gains no
 * runtime dependency). This file is the one place both meet: if the two
 * shapes drift apart, Dot's needs check rejects the `.use(schedule(...))`
 * below and the typecheck fails.
 */
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/plugin';
import { durableScheduler } from '@arki/queue/dot';

import { DurableSchedules, schedule } from './dot.js';
import { defineSchedule } from './index.js';

describe('the BullMQ backend fits the durable port', () => {
  it('an app wires durableScheduler() into schedule({ durable }) without a cast', () => {
    const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', durable: true, handler: () => Promise.resolve() });
    // Declaring the backend opens no connection: Redis is reached only when a schedule starts.
    const app = defineApp('durable-port')
      .use(durableScheduler({ connection: 'redis://127.0.0.1:6379' }))
      .use(schedule({ schedules: [nightly], durable: DurableSchedules }))
      .configure();
    expect(app.manifest.actions).toContainEqual(expect.objectContaining({ id: 'nightly.fire', plugin: 'schedule' }));
  });
});
