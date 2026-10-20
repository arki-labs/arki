/**
 * Tests for `DotLifecycleObserver` + the in-process emission seam.
 *
 * Verifies:
 *   - Configure-time events fire when observers are passed through
 *     `defineApp(name, { observers })` at construction.
 *   - Boot/start/stop/dispose phase + per-plugin hook events fire in
 *     order, with correct `status`/`durationMs`/`error` fields.
 *   - `subscribe()` returns an unsubscribe function that actually works.
 *   - Observer exceptions are caught and don't break the lifecycle.
 *   - `#emitIfObserved` allocates nothing when no observers — verified
 *     by exercising the lifecycle with no observers and confirming the
 *     existing 89-test suite stays green (no regression).
 */

import { orThrow, UnexpectedDefect } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import type { DotLifecycleEvent, DotLifecycleObserver } from './lifecycle-observer.js';
import { defineApp } from './define-app.js';
import { plugin } from './plugin-contract.js';

describe('DotLifecycleObserver — happy path', () => {
  it('emits configure phase + hook events when observer is passed at construction', () => {
    const events: DotLifecycleEvent[] = [];
    const observer: DotLifecycleObserver = e => events.push(e);

    const pluginA = plugin({
      name: 'a',
      configure() {
        /* sync */
      },
    });

    orThrow(defineApp('configure-events', { observers: [observer] }).use(pluginA).configure());

    // Expected sequence: phase-starting -> hook-starting -> hook-completed -> phase-completed
    expect(events.map(e => `${e.kind}:${e.status}`)).toEqual([
      'phase:starting',
      'plugin-hook:starting',
      'plugin-hook:completed',
      'phase:completed',
    ]);

    // Verify shape of each event type.
    const phaseStart = events[0]!;
    expect(phaseStart.kind).toBe('phase');
    expect(phaseStart.appName).toBe('configure-events');
    if (phaseStart.kind === 'phase') {
      expect(phaseStart.phase).toBe('configure');
    }
    expect(phaseStart.timestamp).toBeGreaterThan(0);

    const hookComplete = events[2]!;
    expect(hookComplete.kind).toBe('plugin-hook');
    if (hookComplete.kind === 'plugin-hook') {
      expect(hookComplete.plugin).toBe('a');
      expect(hookComplete.phase).toBe('configure');
      expect(hookComplete.order).toBe(0);
      expect(hookComplete.durationMs).toBeGreaterThanOrEqual(0);
    }

    const phaseComplete = events[3]!;
    expect(phaseComplete.status).toBe('completed');
    expect(phaseComplete.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits the full configure→boot→dispose event stream on a healthy app', async () => {
    const events: DotLifecycleEvent[] = [];

    const pluginA = plugin({
      name: 'a',
      configure() {
        /* sync */
      },
      provides: {
        a: () => ({ ok: true }),
      },
      async dispose() {
        /* async no-op */
      },
    });

    const app = orThrow(await defineApp('full-lifecycle', { observers: [e => events.push(e)] })
      .use(pluginA)
      .boot());

    orThrow(await app.dispose());

    // The full stream — configure (phase start, hook start, hook done, phase done)
    // + boot (phase start, hook start, hook done, phase done)
    // + dispose (phase start, hook start, hook done, phase done).
    const tags = events.map(e => `${e.kind}:${e.status}`);
    expect(tags).toEqual([
      'phase:starting',
      'plugin-hook:starting',
      'plugin-hook:completed',
      'phase:completed',
      'phase:starting',
      'plugin-hook:starting',
      'plugin-hook:completed',
      'phase:completed',
      'phase:starting',
      'plugin-hook:starting',
      'plugin-hook:completed',
      'phase:completed',
    ]);

    // Phase mix should be exactly { configure, boot, dispose }.
    const phaseEvents = events.filter((e): e is Extract<DotLifecycleEvent, { kind: 'phase' }> => e.kind === 'phase');
    expect(phaseEvents.map(e => e.phase)).toEqual(['configure', 'configure', 'boot', 'boot', 'dispose', 'dispose']);
  });
});

describe('DotLifecycleObserver — failure path', () => {
  it('emits hook-failed + phase-failed when a boot hook throws', async () => {
    const events: DotLifecycleEvent[] = [];

    const badPlugin = plugin({
      name: 'bad',
      boot() {
        throw new Error('boot-broken');
      },
    });

    const failure = await defineApp('boot-fail', { observers: [e => events.push(e)] }).use(badPlugin).boot();
    expect(failure).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boot-broken') });

    // Find the boot-phase hook-failed event.
    const hookFailed = events.find(
      (e): e is Extract<DotLifecycleEvent, { kind: 'plugin-hook' }> =>
        e.kind === 'plugin-hook' && e.phase === 'boot' && e.status === 'failed',
    );
    expect(hookFailed).toBeDefined();
    expect(hookFailed?.plugin).toBe('bad');
    expect(hookFailed?.error).toBe(failure);
    expect(hookFailed?.error).toMatchObject({ code: UnexpectedDefect.code, cause: new Error('boot-broken') });
    expect(hookFailed?.durationMs).toBeGreaterThanOrEqual(0);

    // And the boot phase itself must end as `failed`.
    const phaseFailed = events.find(
      (e): e is Extract<DotLifecycleEvent, { kind: 'phase' }> =>
        e.kind === 'phase' && e.phase === 'boot' && e.status === 'failed',
    );
    expect(phaseFailed).toBeDefined();
    expect(phaseFailed?.error).toBe(failure);
  });
});

describe('DotLifecycleObserver — subscribe / unsubscribe', () => {
  it('subscribe() on a booted app sees subsequent events; unsubscribe stops the stream', async () => {
    const events: DotLifecycleEvent[] = [];
    const pluginA = plugin({
      name: 'a',
      boot() {
        /* noop */
      },
      async stop() {
        /* */
      },
      async dispose() {
        /* */
      },
    });

    const app = orThrow(await defineApp('subscribe-test').use(pluginA).start());

    // No observer was registered at construction — so events is empty so far.
    expect(events).toEqual([]);

    const unsubscribe = app.subscribe(e => events.push(e));

    expect(await app.stop()).toBeUndefined();
    expect(events.some(e => e.kind === 'phase' && e.phase === 'stop' && e.status === 'starting')).toBe(true);

    unsubscribe();
    events.length = 0;

    orThrow(await app.dispose());
    // No dispose events should land after unsubscribe.
    expect(events).toEqual([]);
  });
});

describe('DotLifecycleObserver — fault isolation', () => {
  it('catches observer exceptions and continues firing other observers', async () => {
    const events: DotLifecycleEvent[] = [];
    const goodObserver: DotLifecycleObserver = e => events.push(e);
    const badObserver: DotLifecycleObserver = () => {
      throw new Error('observer-misbehaved');
    };

    const pluginA = plugin({
      name: 'a',
      boot() {
        /* noop */
      },
    });

    // Bad observer registered FIRST — if it could break the chain, the
    // good observer would see zero events.
    orThrow(await defineApp('isolated-observers', { observers: [badObserver, goodObserver] })
      .use(pluginA)
      .boot());

    // The good observer must still have received the full event stream.
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.kind === 'phase' && e.status === 'completed')).toBe(true);
  });
});

describe('renderTimeline integration', () => {
  it('app.timeline() returns a non-empty ASCII waterfall after boot', async () => {
    const pluginA = plugin({
      name: 'a',
      configure() {
        /* */
      },
      boot() {
        /* noop */
      },
    });
    const pluginB = plugin({
      name: 'b',
      configure() {
        /* */
      },
      boot() {
        /* noop */
      },
    });

    const app = orThrow(await defineApp('timeline-test').use(pluginA).use(pluginB).boot());
    try {
      const timeline = app.timeline();
      // Header line is present
      expect(timeline).toContain('Timeline: timeline-test');
      // Both phases that ran are present
      expect(timeline).toContain('configure');
      expect(timeline).toContain('boot');
      // Both plugins are present
      expect(timeline).toContain('a');
      expect(timeline).toContain('b');
      // At least one bar character is rendered
      expect(timeline).toMatch(/█/);
    } finally {
      orThrow(await app.dispose());
    }
  });
});
