/**
 * The logging slot (`@arki/log` redesign RFC §9): one unit may fill it; the
 * kernel activates logging after pure configure and closes it after the last
 * boot or teardown record.
 */

import { describe, expect, it, vi } from 'vitest';

import type { LogRecord, Sink } from '@arki/log';
import { defineFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { configure } from '@arki/log';

import { defineApp } from '../define-app.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { infra } from '../unit-contract.js';

/** A sink that records what it got, and how many records it had when it was closed. */
function recordingSink(): Sink & { readonly records: LogRecord[]; closedAt: number | undefined } {
  const sink = {
    records: [] as LogRecord[],
    closedAt: undefined as number | undefined,
    write: (record: LogRecord) => {
      sink.records.push(record);
    },
    close: () => {
      sink.closedAt = sink.records.length;
    },
  };
  return sink;
}

function loggingUnit(sink: Sink, name = 'logging') {
  return infra({
    name,
    logging: () => {
      const handle = configure({ channels: { mem: sink }, default: { level: 'trace', channels: ['mem'] } });
      return {
        async close() {
          await handle.close();
        },
      };
    },
  });
}

describe('logging slot', () => {
  it('captures the first and the last lifecycle record, then closes logging', async () => {
    const sink = recordingSink();
    const app = orThrow(
      await defineApp('slot-app')
        .infra(loggingUnit(sink))
        .infra(
          infra({
            name: 'db',
            boot: () => {
              /* side effects only */
            },
          }),
        )
        .boot(),
    );
    orThrow(await app.dispose());

    const lifecycle = sink.records.filter(record => record.category === 'arki:dot:lifecycle');
    expect(lifecycle[0]?.template).toBe('boot: starting');
    expect(lifecycle.at(-1)?.template).toBe('dispose: complete');
    expect(lifecycle[0]?.fields['dot.app.name']).toBe('slot-app');
    // Closed after the last record, not before.
    expect(sink.closedAt).toBe(sink.records.length);
  });

  it('a failed boot still writes the failure, then closes logging', async () => {
    const sink = recordingSink();
    const failing = infra({
      name: 'broken',
      boot: () => {
        throw new Error('database unreachable');
      },
    });

    const failure = await defineApp('failing-app').infra(loggingUnit(sink)).infra(failing).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: new Error('database unreachable') });

    expect(
      sink.records.some(record => record.levelName === 'error' && record.template.startsWith('boot: FAILED')),
    ).toBe(true);
    expect(sink.closedAt).toBe(sink.records.length);
  });

  it('rejects two logging units with a coded error, before anything is switched on', async () => {
    const first = recordingSink();
    const second = recordingSink();

    const attempt = defineApp('two-loggers')
      .infra(loggingUnit(first, 'log-a'))
      .infra(loggingUnit(second, 'log-b'))
      .boot();

    await expect(attempt).resolves.toMatchObject({
      code: UnexpectedDefect.code,
      cause: { code: DotLifecycleErrorCode.DuplicateLogging },
    });
    expect(first.records).toHaveLength(0);
    expect(second.records).toHaveLength(0);
  });
});

describe('owned logging lifetime', () => {
  it('keeps configure free of logging activation and opens the slot once at boot', async () => {
    let activations = 0;
    let closes = 0;
    const configured = orThrow(
      defineApp('pure-configure')
        .infra(
          infra({
            name: 'logger',
            logging: () => {
              activations += 1;
              return {
                async close() {
                  closes += 1;
                  await Promise.resolve();
                },
              };
            },
          }),
        )
        .configure(),
    );
    expect(activations).toBe(0);
    const app = orThrow(await configured.boot());
    expect(activations).toBe(1);
    orThrow(await app.dispose());
    expect(closes).toBe(1);
  });

  it('does not acquire a logging lifetime if configure fails', async () => {
    const ConfigureFailed = defineFailure('test.logging.configure_failed');
    const failure = ConfigureFailed();
    let activations = 0;
    const outcome = await defineApp('failed-configure')
      .infra(
        infra({
          name: 'logger',
          logging: () => {
            activations += 1;
            return {
              async close() {
                await Promise.resolve();
              },
            };
          },
        }),
      )
      .infra(infra({ name: 'failed', configure: () => failure }))
      .boot();
    expect(outcome).toBe(failure);
    expect(activations).toBe(0);
  });

  it('returns a logging close defect with owner metadata even if its fallback reporter throws', async () => {
    const cause = new Error('log close failed');
    const reporter = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('reporter broke');
    });
    try {
      const app = orThrow(
        await defineApp('logging-close')
          .infra(infra({ name: 'logger', logging: () => ({ close: () => Promise.reject(cause) }) }))
          .boot(),
      );
      const result = await app.dispose();
      expect(result).toMatchObject({
        code: UnexpectedDefect.code,
        cause: { code: DotLifecycleErrorCode.DisposeFailed, phase: 'dispose', plugin: 'logger', cause },
      });
      expect(reporter).toHaveBeenCalledOnce();
      expect(await app.dispose()).toBe(result);
    } finally {
      reporter.mockRestore();
    }
  });

  it('keeps primary identity inside an aggregate when logging cleanup also fails', async () => {
    const BootFailed = defineFailure('test.logging.boot_failed');
    const primary = BootFailed();
    const cause = new Error('log close failed');
    const reporter = vi.spyOn(console, 'error').mockImplementation(() => {
      /* Expected fallback report. */
    });
    try {
      const outcome = await defineApp('logging-rollback')
        .infra(infra({ name: 'logger', logging: () => ({ close: () => Promise.reject(cause) }) }))
        .infra(infra({ name: 'failed', boot: () => primary }))
        .boot();
      expect(outcome).toMatchObject({
        code: 'async.scope_failed',
        cause: {
          primary: [primary],
          cleanup: [{ code: UnexpectedDefect.code, cause: { phase: 'dispose', plugin: 'logger', cause } }],
        },
      });
      expect(reporter).toHaveBeenCalledOnce();
    } finally {
      reporter.mockRestore();
    }
  });
});
