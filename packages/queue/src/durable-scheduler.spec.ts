import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { plugin, service } from '@arki/dot/plugin';

import { DURABLE_SCHEDULES_KEY, durableScheduler } from './dot.ts';
import type { DurableScheduler } from './durable-scheduler.ts';
import { createDurableScheduler } from './durable-scheduler.ts';

// These tests need no Redis: the backend must stay inert until `start`, so
// declaring and booting an app never reaches for the network.
describe('durable scheduler backend', () => {
  it('opens no connection until start, and stop is safe before start and twice', async () => {
    const scheduler = createDurableScheduler({ connection: 'redis://localhost:6379' });

    await expect(scheduler.stop()).resolves.toBeUndefined();
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('durableScheduler() provides the backend under the key @arki/schedule needs', async () => {
    let received: DurableScheduler | undefined;
    const consumer = plugin({
      name: 'consumer',
      needs: { [DURABLE_SCHEDULES_KEY]: service<DurableScheduler>() },
      boot: ctx => {
        received = ctx[DURABLE_SCHEDULES_KEY];
      },
    });
    const app = await defineApp('durable-backend')
      .use(durableScheduler({ connection: 'redis://localhost:6379' }))
      .use(consumer)
      .boot();

    expect(DURABLE_SCHEDULES_KEY).toBe('arki.schedule.durable');
    expect(typeof received?.start).toBe('function');
    expect(typeof received?.stop).toBe('function');
    expect(app.manifest.plugins.find(entry => entry.name === 'durable-scheduler')?.provides).toContain('durable-scheduler');
    await app.dispose();
  });
});
