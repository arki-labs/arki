import { describe, expect, it, vi } from 'vitest';

import { defineFailure, orThrow } from '@arki/failure';

import type { EmptyShape } from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { initPlugins } from '../init-plugins.js';
import { createPlugin, plugin } from '../plugin-contract.js';

const Open = defineFailure('test.logging_failures.open');
const Close = defineFailure('test.logging_failures.close');
const Dispose = defineFailure('test.logging_failures.dispose');

describe('logging failures', () => {
  it.each(['plugin', 'constructor', 'keys', 'witness'] as const)(
    '%s checks activation before providers run',
    async form => {
      const failure = Open();
      const factory = initPlugins.context<EmptyShape>().create();
      let activated = 0;
      let provided = 0;
      const definition = {
        name: 'logger',
        logging: () => {
          activated++;
          return failure;
        },
        provides: { value: () => ++provided },
      };
      const logger =
        form === 'keys'
          ? factory.plugin(definition)
          : form === 'witness'
            ? factory.plugin({ ...definition, needs: {} })
            : form === 'constructor'
              ? createPlugin(definition)
              : plugin(definition);
      const configured = orThrow(defineApp('activation').use(logger).configure());
      expect(activated).toBe(0);
      expect(await configured.boot()).toBe(failure);
      expect(activated).toBe(1);
      expect(provided).toBe(0);
    },
  );

  it('returns the same close failure once even when its fallback reporter throws', async () => {
    const failure = Close();
    let closes = 0;
    const reporter = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('reporter');
    });
    try {
      const app = orThrow(
        await defineApp('close')
          .use(
            plugin({
              name: 'logger',
              logging: () => ({
                close: () => {
                  closes++;
                  return Promise.resolve(failure);
                },
              }),
            }),
          )
          .boot(),
      );
      expect(await app.dispose()).toBe(failure);
      expect(await app.dispose()).toBe(failure);
      expect(closes).toBe(1);
      expect(reporter).toHaveBeenCalledOnce();
    } finally {
      reporter.mockRestore();
    }
  });

  it('keeps logging cleanup last behind earlier plugin cleanup during failed startup', async () => {
    const primary = Open();
    const earlier = Dispose();
    const logging = Close();
    const events: string[] = [];
    const reporter = vi.spyOn(console, 'error').mockImplementation(() => {
      /* Expected fallback. */
    });
    try {
      const outcome = await defineApp('rollback')
        .use(
          plugin({
            name: 'logger',
            logging: () => ({
              close: () => {
                events.push('logging');
                return logging;
              },
            }),
          }),
        )
        .use(
          plugin({
            name: 'earlier',
            dispose: () => {
              events.push('earlier');
              return earlier;
            },
          }),
        )
        .use(plugin({ name: 'failed', boot: () => primary }))
        .boot();
      expect(outcome).toMatchObject({
        code: 'async.scope_failed',
        cause: { primary: [primary], cleanup: [earlier, logging] },
      });
      if ('code' in outcome && outcome.code === 'async.scope_failed') {
        expect(outcome.cause.primary[0]).toBe(primary);
        expect(outcome.cause.cleanup[0]).toBe(earlier);
        expect(outcome.cause.cleanup[1]).toBe(logging);
      }
      expect(events).toEqual(['earlier', 'logging']);
    } finally {
      reporter.mockRestore();
    }
  });

  it('executes the replacement logging factory instead of the original', async () => {
    const failure = Open();
    const original = plugin({
      name: 'logger',
      logging: () => ({
        close() {
          throw new Error('original');
        },
      }),
    });
    const replacement = { ...original, logging: () => failure };
    expect(await defineApp('replacement').use(replacement).boot()).toBe(failure);
  });
});
