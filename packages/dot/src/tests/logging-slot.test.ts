/**
 * The logging slot (`@arki/log` redesign RFC §9): one plugin may fill it; the
 * kernel switches logging on before its first lifecycle record and off after
 * its last, so nothing the app logs about its own life is lost.
 */

import { orThrow, UnexpectedDefect } from '@arki/failure';
import { describe, expect, it } from 'vitest';

import type { LogRecord, Sink } from '@arki/log';
import { configure } from '@arki/log';

import { defineApp } from '../define-app.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { plugin } from '../plugin-contract.js';

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

function loggingPlugin(sink: Sink, name = 'logging') {
  return plugin({
    name,
    logging: () => configure({ channels: { mem: sink }, default: { level: 'trace', channels: ['mem'] } }),
  });
}

describe('logging slot', () => {
  it('captures the first and the last lifecycle record, then closes logging', async () => {
    const sink = recordingSink();
    const app = orThrow(await defineApp('slot-app')
      .use(loggingPlugin(sink))
      .use(
        plugin({
          name: 'db',
          boot: () => {
            /* side effects only */
          },
        }),
      )
      .boot());
    orThrow(await app.dispose());

    const lifecycle = sink.records.filter(record => record.category === 'arki:dot:lifecycle');
    expect(lifecycle[0]?.template).toBe('configure: starting');
    expect(lifecycle.at(-1)?.template).toBe('dispose: complete');
    expect(lifecycle[0]?.fields['dot.app.name']).toBe('slot-app');
    // Closed after the last record, not before.
    expect(sink.closedAt).toBe(sink.records.length);
  });

  it('a failed boot still writes the failure, then closes logging', async () => {
    const sink = recordingSink();
    const failing = plugin({
      name: 'broken',
      boot: () => {
        throw new Error('database unreachable');
      },
    });

    const failure = await defineApp('failing-app').use(loggingPlugin(sink)).use(failing).boot();
    expect(UnexpectedDefect.is(failure)).toBe(true);
    expect(failure).toMatchObject({ cause: new Error('database unreachable') });

    expect(
      sink.records.some(record => record.levelName === 'error' && record.template.startsWith('boot: FAILED')),
    ).toBe(true);
    expect(sink.closedAt).toBe(sink.records.length);
  });

  it('rejects two logging plugins with a coded error, before anything is switched on', async () => {
    const first = recordingSink();
    const second = recordingSink();

    const attempt = defineApp('two-loggers')
      .use(loggingPlugin(first, 'log-a'))
      .use(loggingPlugin(second, 'log-b'))
      .boot();

    await expect(attempt).rejects.toBeInstanceOf(DotLifecycleError);
    await expect(attempt).rejects.toMatchObject({ code: DotLifecycleErrorCode.DuplicateLogging });
    expect(first.records).toHaveLength(0);
    expect(second.records).toHaveLength(0);
  });
});
