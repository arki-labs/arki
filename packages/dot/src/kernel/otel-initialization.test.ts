/** Loading Dot before or after a defective SDK must not prevent the app from running. */
import { createNoopMeter, metrics, trace } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';

import { orThrow } from '@arki/failure';

function broken(): never {
  throw new Error('reporter unavailable');
}

afterEach(() => {
  vi.restoreAllMocks();
  metrics.disable();
  trace.disable();
  vi.resetModules();
});

it.each(['tracer', 'meter', 'histogram'] as const)(
  'runs the lifecycle when %s acquisition fails before the module is imported',
  async source => {
    if (source === 'tracer') vi.spyOn(trace, 'getTracer').mockImplementation(broken);
    if (source === 'meter') vi.spyOn(metrics, 'getMeter').mockImplementation(broken);
    if (source === 'histogram') {
      vi.spyOn(metrics, 'getMeter').mockReturnValue({ ...createNoopMeter(), createHistogram: broken });
    }
    const { defineApp } = await import('../define-app.js');
    const { infra } = await import('../unit-contract.js');
    const calls: string[] = [];
    const app = orThrow(
      await defineApp('early-sdk')
        .infra(
          infra({
            name: 'work',
            boot: () => {
              calls.push('boot');
            },
            dispose: () => {
              calls.push('dispose');
            },
          }),
        )
        .start(),
    );
    orThrow(await app.dispose());
    expect(calls).toEqual(['boot', 'dispose']);
  },
);

it('records lifecycle metrics when the app installs its provider after importing Dot', async () => {
  const { defineApp } = await import('../define-app.js');
  const { infra } = await import('../unit-contract.js');
  let bootCount = 0;
  const boot = (): undefined => {
    bootCount += 1;
  };
  const recorded: string[] = [];
  const noop = createNoopMeter();
  metrics.setGlobalMeterProvider({
    getMeter: () => ({
      ...noop,
      createHistogram: (name, options) => ({
        ...noop.createHistogram(name, options),
        record: () => {
          recorded.push(name);
        },
      }),
    }),
  });
  const app = orThrow(
    await defineApp('late-sdk')
      .infra(
        infra({
          name: 'work',
          boot,
        }),
      )
      .start(),
  );
  orThrow(await app.dispose());
  expect(bootCount).toBe(1);
  expect(recorded).toContain('dot.app.phase.duration');
  expect(recorded).toContain('dot.unit.hook.duration');
});

function unclassifiableSuccess() {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error('prototype lookup unavailable');
      },
    },
  );
}

it('preserves synchronous success when telemetry cannot classify the returned object', async () => {
  const { withOutcomeSpan } = await import('./otel.js');
  const value = unclassifiableSuccess();
  let calls = 0;
  const run = () => {
    calls += 1;
    return value;
  };
  const duration = vi.fn();
  const result = withOutcomeSpan(undefined, run, duration);
  expect(result).toBe(value);
  expect(calls).toBe(1);
  // A classification failure must not manufacture a successful metric sample.
  expect(duration).not.toHaveBeenCalled();
});

it('preserves promise identity and settlement when telemetry cannot classify the resolved object', async () => {
  const { withOutcomeSpan } = await import('./otel.js');
  const value = unclassifiableSuccess();
  const promise = Promise.resolve(value);
  let calls = 0;
  const run = () => {
    calls += 1;
    return promise;
  };
  const duration = vi.fn();
  const result = withOutcomeSpan(undefined, run, duration);
  expect(result).toBe(promise);
  expect(await result).toBe(value);
  expect(calls).toBe(1);
  expect(duration).not.toHaveBeenCalled();
});

it('preserves thrown and rejected causes even when exception inspection fails', async () => {
  const { withOutcomeSpan } = await import('./otel.js');
  const cause = unclassifiableSuccess();
  const duration = vi.fn();
  let caught: unknown;
  try {
    withOutcomeSpan(undefined, () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- JavaScript callbacks may throw hostile objects.
      throw cause;
    }, duration);
  } catch (error) {
    caught = error;
  }
  expect(caught === cause).toBe(true);
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Foreign promises may reject with hostile objects.
  const pending = Promise.reject(cause);
  const returned = withOutcomeSpan(undefined, () => pending, duration);
  expect(returned).toBe(pending);
  await pending.catch(error => {
    expect(error === cause).toBe(true);
  });
  expect(duration.mock.calls).toEqual([['failed'], ['failed']]);
});
