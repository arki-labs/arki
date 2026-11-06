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

  it('starts a new trace for each timer tick, so a background job never appears as part of app startup', async () => {
    using spans = captureSpans();
    const ticks: string[] = [];
    const recordTick = () => ticks.push('beat');
    const tickCore = defineFeature('tick').usecases({ beat: () => recordTick });
    const tick = tickCore.entrypoints(
      schedules(tickCore, [{ name: 'beat', every: '1s', handler: ({ usecases }) => usecases.beat() }]),
    );
    // The internal clock arms the timer inside Dot's start hook, under the `dot.unit.start` span.
    const app = orThrow(await defineApp('schedule-tick-telemetry').features([tick]).entrypoints(schedule({})).start());
    try {
      for (let wait = 0; wait < 300 && ticks.length === 0; wait++) await new Promise(r => setTimeout(r, 10));
    } finally {
      orThrow(await app.dispose());
    }

    expect(ticks.length).toBeGreaterThan(0);
    const run = spans.finished.find(span => span.name === 'schedule.run');
    if (run === undefined) throw new Error('no schedule.run span finished');
    const startup = spans.finished.filter(span => span.name === 'dot.unit.start');
    expect(startup.length).toBeGreaterThan(0);
    // A root span in a trace of its own: not under the ended `dot.unit.start` span, nor in its trace.
    expect(run.parentSpanContext).toBeUndefined();
    for (const span of startup) expect(run.spanContext().traceId).not.toBe(span.spanContext().traceId);
  });
});
