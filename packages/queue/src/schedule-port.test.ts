/** Queue owns the adapter; schedule owns the canonical port. This test locks their Dot wiring. */
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';
import { durableScheduler } from '@arki/queue/dot';
import { defineSchedule } from '@arki/schedule';
import { DurableSchedules, schedule } from '@arki/schedule/dot';

describe('the BullMQ backend fits the durable port', () => {
  it('an app wires durableScheduler() into schedule({ durable }) without a cast', () => {
    const nightly = defineSchedule({
      name: 'nightly',
      cron: '0 3 * * *',
      durable: true,
      handler: () => Promise.resolve(),
    });
    // Declaring the backend opens no connection: Redis is reached only when a schedule starts.
    const app = orThrow(
      defineApp('durable-port')
        .use(durableScheduler({ connection: 'redis://127.0.0.1:6379' }))
        .serve(schedule({ schedules: [nightly], durable: DurableSchedules }))
        .configure(),
    );
    expect(app.manifest.actions).toContainEqual(expect.objectContaining({ id: 'nightly.fire', plugin: 'schedule' }));
  });
});
