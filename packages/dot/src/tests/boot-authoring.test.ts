import { describe, expect, it } from 'vitest';

import { resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import { defineApp } from '../define-app.js';
import { feature } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { createPlugin, plugin, rename } from '../plugin-contract.js';

const Refused = defineFailure('test.boot_authoring.refused');

describe('boot authoring', () => {
  it.each(['plugin', 'constructor', 'feature', 'keys', 'witness'] as const)(
    '%s preserves failure identity and releases providers before returning it',
    async form => {
      const failure = Refused();
      const db = { value: 42 };
      const events: string[] = [];
      const provides = {
        db: () =>
          resource(
            () => db,
            () => {
              events.push('close');
            },
          ),
      };
      const boot = ({ db: provided }: { db: typeof db }) => {
        expect(provided).toBe(db);
        events.push('boot');
        return Promise.resolve(failure);
      };
      const start = (): undefined => {
        events.push('start');
      };
      const factory = initPlugins.context<{ db: typeof db }>().create();
      const app = defineApp(`boot-${form}`);
      const mounted =
        form === 'feature'
          ? app.features([feature('domain', { provides, boot, start })])
          : app.use(
              form === 'keys'
                ? factory.plugin({ name: 'domain', provides, boot, start })
                : form === 'witness'
                  ? factory.plugin({ name: 'domain', needs: {}, provides, boot, start })
                  : form === 'constructor'
                    ? createPlugin({ name: 'domain', provides, boot, start })
                    : plugin({ name: 'domain', provides, boot, start }),
            );
      expect(await mounted.start()).toBe(failure);
      expect(events).toEqual(['boot', 'close']);
    },
  );
});

it('runs replacement boot and providers, and closes only the resources they acquire', async () => {
  const events: string[] = [];
  const failure = Refused();
  const original = plugin({
    name: 'source',
    provides: {
      value: () =>
        resource(
          () => 1,
          () => {
            events.push('original-close');
          },
        ),
    },
    boot: () => {
      events.push('original-boot');
    },
  });
  const actual = rename(
    {
      ...original,
      factories: {
        value: () =>
          resource(
            () => {
              events.push('replacement-provider');
              return 2;
            },
            () => {
              events.push('replacement-close');
            },
          ),
      },
      hooks: {
        boot: ({ value }: { value: number }) => {
          events.push(`replacement-boot:${value}`);
          return failure;
        },
      },
    },
    { value: 'renamed' },
  );
  expect(await defineApp('replacement').use(actual).boot()).toBe(failure);
  expect(events).toEqual(['replacement-provider', 'replacement-boot:2', 'replacement-close']);
});

it('returns a replacement provider failure before boot runs', async () => {
  const failure = Refused();
  let calls = 0;
  const actual = {
    ...plugin({ name: 'source', provides: { value: () => 1 } }),
    factories: { value: () => failure },
    hooks: {
      boot: (): undefined => {
        calls++;
      },
    },
  };
  expect(await defineApp('replacement-provider').use(actual).boot()).toBe(failure);
  expect(calls).toBe(0);
});

it('object feature replacements use the actual providers and boot', async () => {
  const events: string[] = [];
  const failure = Refused();
  const domain = {
    ...feature('source', {
      provides: {
        value: () => {
          events.push('original-provider');
          return 1;
        },
      },
      boot: () => {
        events.push('original-boot');
      },
    }),
    factories: {
      value: () => {
        events.push('replacement-provider');
        return 2;
      },
    },
    boot: ({ value }: { value: number }) => {
      events.push(`replacement-boot:${value}`);
      return failure;
    },
  };
  expect(await defineApp('feature-replacement').features([domain]).boot()).toBe(failure);
  expect(events).toEqual(['replacement-provider', 'replacement-boot:2']);
});
