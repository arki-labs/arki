/**
 * `log()` from `@arki/dot/log`: one `.use(...)` switches logging on for the
 * whole life of a Dot app, so its boot and shutdown records are never lost.
 */

import { describe, expect, it } from 'vitest';

import type { Configured } from '@arki/log';
import { getLogger, memorySink } from '@arki/log';

import { defineApp } from '../define-app.js';
import { log } from '../log.js';
import { plugin, service } from '../plugin-contract.js';

describe('log()', () => {
  it('writes the lifecycle to its channels and closes after dispose: complete', async () => {
    const sink = memorySink();
    let closedWith = -1;
    const closing = { ...sink, close: () => void (closedWith = sink.records.length) };

    const app = await defineApp('checkout')
      .use(log(() => ({ channels: { mem: closing }, default: { level: 'debug', channels: ['mem'] } })))
      .boot();
    await app.dispose();

    const lifecycle = sink.records.filter(record => record.category === 'arki:dot:lifecycle');
    expect(lifecycle[0]?.template).toBe('configure: starting');
    expect(lifecycle.at(-1)?.template).toBe('dispose: complete');
    expect(closedWith).toBe(sink.records.length);
  });

  it('names the service after the app unless the config says otherwise', async () => {
    const sink = memorySink();
    const app = await defineApp('checkout')
      .use(log(() => ({ channels: { mem: sink }, default: { level: 'info', channels: ['mem'] } })))
      .boot();
    getLogger('app').info('ready');
    await app.dispose();
    expect(sink.records.find(record => record.category === 'app')?.resource['service.name']).toBe('checkout');

    const named = memorySink();
    const second = await defineApp('checkout')
      .use(
        log(() => ({
          channels: { mem: named },
          default: { level: 'info', channels: ['mem'] },
          resource: { 'service.name': 'checkout-worker' },
        })),
      )
      .boot();
    getLogger('app').info('ready');
    await second.dispose();
    expect(named.records.find(record => record.category === 'app')?.resource['service.name']).toBe('checkout-worker');
  });

  it('publishes the configure() handle as the logging service', async () => {
    const sink = memorySink();
    let flushedInBoot = false;
    const app = await defineApp('checkout')
      .use(log(() => ({ channels: { mem: sink }, default: { level: 'info', channels: ['mem'] } })))
      .use(
        plugin({
          name: 'flush-on-boot',
          needs: { logging: service<Configured<'mem'>>() },
          boot: async ({ logging }) => {
            await logging.flush();
            flushedInBoot = true;
          },
        }),
      )
      .boot();
    expect(flushedInBoot).toBe(true);
    await app.dispose();
  });

  it('runs the config thunk at boot, not when log() is called', () => {
    let calls = 0;
    log(() => {
      calls += 1;
      return { channels: { mem: memorySink() }, default: { level: 'info', channels: ['mem'] } };
    });
    expect(calls).toBe(0);
  });
});
