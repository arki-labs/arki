import { afterEach, describe, expect, it } from 'vitest';

import { defineApp, DotPluginError } from '@arki/dot/plugin';
import { orThrow } from '@arki/failure';
import { fakeLog } from '@arki/log/testing';

import { resilience, RESILIENCE_PLUGIN_ERROR_CODES } from './dot.js';
import { backoff, definePresets } from './index.js';

/** Passed to `.catch` where the test only needs the call to settle. */
function swallow(): void {
  // the failure is expected
}

const boom = (): never => {
  throw new Error('down');
};

function makePresets() {
  return definePresets({
    carrier: { circuitBreaker: { consecutiveFailures: 1 }, retry: backoff.constant(1).upTo(1) },
  });
}

let fake: ReturnType<typeof fakeLog> | undefined;

/** How many records the resilience plugin has logged so far (the app kernel logs its own lifecycle too). */
function resilienceRecords(log: ReturnType<typeof fakeLog>): number {
  return log.records.filter(record => record.category === 'arki:resilience').length;
}

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

describe('@arki/resilience/dot', () => {
  it('registers one resilience service in the manifest', () => {
    const configured = defineApp('resilience-manifest').use(resilience(makePresets())).configure();
    expect(configured.manifest.services).toEqual([{ name: 'resilience', plugin: 'resilience', kind: 'custom' }]);
  });

  it('publishes the presets under their names; the handle is the preset itself', async () => {
    const presets = makePresets();
    const app = await orThrow(defineApp('resilience-publish').use(resilience(presets)).boot());
    expect(app.services.resilience.for('carrier')).toBe(presets.carrier);
    expect(await app.services.resilience.run('carrier', () => 7)).toBe(7);
    await orThrow(app.dispose());
  });

  it('logs retry and breaker events at debug, and stops after dispose', async () => {
    fake = fakeLog();
    const presets = makePresets();
    const app = await orThrow(defineApp('resilience-logs').use(resilience(presets)).boot());
    await app.services.resilience.run('carrier', boom).catch(swallow);

    fake.assertLogged({
      level: 'debug',
      category: 'arki:resilience',
      fields: { preset: 'carrier' },
      template: 'preset {preset}: retry {attempt} in {delay} ms ({error})',
    });
    fake.assertLogged({
      level: 'debug',
      category: 'arki:resilience',
      template: 'preset {preset}: circuit opened ({error})',
    });
    const before = resilienceRecords(fake);

    await orThrow(app.dispose());
    await presets.carrier.components.retry.execute(boom).catch(swallow);
    expect(resilienceRecords(fake)).toBe(before);
  });

  it('disposing one app leaves another app logging', async () => {
    fake = fakeLog();
    const presets = definePresets({ solo: { retry: backoff.constant(1).upTo(1) } });
    const a = await orThrow(defineApp('resilience-a').use(resilience(presets)).boot());
    const b = await orThrow(defineApp('resilience-b').use(resilience(presets)).boot());
    await orThrow(a.dispose());
    const before = resilienceRecords(fake);
    await presets.solo.components.retry.execute(boom).catch(swallow);

    // One retry record from app b only; app a's subscriptions are gone.
    expect(resilienceRecords(fake) - before).toBe(1 + 1); // retry + give up
    await orThrow(b.dispose());
  });

  it('dispose twice is harmless', async () => {
    const app = await orThrow(defineApp('resilience-twice').use(resilience(makePresets())).boot());
    await orThrow(app.dispose());
    await expect(app.dispose()).resolves.toBeUndefined();
  });

  it('an unknown name from untyped code throws a coded error', async () => {
    const app = await orThrow(defineApp('resilience-unknown').use(resilience(makePresets())).boot());
    const service = app.services.resilience;
    let thrown: unknown;
    try {
      // Untyped JS can pass any string; Reflect.apply takes the argument list unchecked.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- handed to Reflect.apply with its service as `this`
      Reflect.apply(service.for, service, ['toString']);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DotPluginError);
    expect(thrown).toMatchObject({ code: RESILIENCE_PLUGIN_ERROR_CODES.unknownPreset });
    await orThrow(app.dispose());
  });
});
