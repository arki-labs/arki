/**
 * Inside a Dot app, a schedule run and Dot's usecase span form one trace: the
 * `schedule.run` span starts the trace and the usecase its handler calls nests
 * under it. So a trace shows which schedule made the usecase run.
 */
import { describe, expect, it } from 'vitest';

import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { schedule, schedules } from './dot.js';

const sendDigest = (to: string) => `sent:${to}`;
const digestCore = defineFeature('digest').usecases({ send: () => sendDigest });
const digest = digestCore.entrypoints(
  schedules(digestCore, [
    { name: 'send-digest', every: '1m', handler: ({ usecases }) => usecases.send('subscribers') },
  ]),
);

describe('@arki/schedule spans inside a Dot app', () => {
  it('nests the Dot usecase span under schedule.run, so a trace shows which schedule ran the usecase', async () => {
    using spans = captureSpans();
    const app = orThrow(
      await defineApp('schedule-telemetry')
        .features([digest])
        .entrypoints(schedule({ clock: 'host' }))
        .boot(),
    );
    try {
      await expect(app.services.scheduler.trigger('send-digest')).resolves.toMatchObject({ status: 'ran' });
    } finally {
      orThrow(await app.dispose());
    }

    const run = spans.named('schedule.run');
    expect(spans.named('feature.digest.send').parent).toBe(run);
    expect(run.attributes['schedule.name']).toBe('send-digest');
  });
});
