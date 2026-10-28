import type { RetryFailure } from './errors.js';

/**
 * DOT adapter for `@arki/resilience`.
 *
 * `resilience(presets)` publishes `services.resilience`: a typed handle on your named presets
 * (`definePresets`). While the app runs, the plugin logs the policy events of every preset
 * (retry, give up, breaker open / half-open / closed, timeout, bulkhead reject) as `debug`
 * records in the `arki:resilience` category. Turn them on with `DEBUG=arki:resilience`.
 * `dispose` ends the subscriptions.
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { definePresets } from '@arki/resilience';
 * import { resilience } from '@arki/resilience/dot';
 * import { orThrow } from '@arki/failure';
 *
 * const presets = definePresets({ carrier: { timeout: { timeoutMs: 10_000 } } });
 * const app = orThrow(await defineApp('my-app').infra(resilience(presets)).boot());
 *
 * await app.services.resilience.run('carrier', () => callCarrier());
 * ```
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/resilience`. Importing this adapter
 * without `@arki/dot` installed fails at module load: it only makes sense in a DOT app.
 */

import type { Logger } from '@arki/log';
import { DotUnitError, infra } from '@arki/dot/unit';
import { getLogger } from '@arki/log';

import type { ResiliencePolicy } from './policies.js';
import type { PolicyCallback, Subscription } from './policy.js';
import type { Presets } from './presets.js';
import { describe } from './events.js';

/**
 * Stable error codes thrown by the resilience plugin. Match on these, never on the message.
 */
export const RESILIENCE_PLUGIN_ERROR_CODES = {
  /**
   * `for` or `run` got a name that is not in the presets (only reachable from untyped JS).
   *
   * @fix Use a name you passed to `definePresets(...)`. Types catch this in TypeScript.
   * @verify cd packages/resilience && bun run test
   */
  unknownPreset: 'ARKI_RESILIENCE_PLUGIN_E001',
} as const;

/** Services published by the resilience adapter. */
export type ResilienceService<N extends string> = {
  /** The preset called `name`. The same object as `presets[name]`, so breaker state is shared. */
  for(name: N): ResiliencePolicy;
  /** Run `fn` through the preset called `name`. */
  run<T>(name: N, fn: PolicyCallback<T>, signal?: AbortSignal): Promise<T | RetryFailure>;
};

const log: Logger = getLogger('arki:resilience');

/** Subscriptions of each booted service. Per service, so two apps never share them. */
const subscriptions = new WeakMap<object, Subscription[]>();

/** Log every event of every part of `policy`. Returns the subscriptions it made. */
function listen(preset: string, policy: ResiliencePolicy, into: Subscription[]): void {
  const { retry, circuitBreaker, timeout, bulkhead } = policy.components;
  into.push(
    retry.onRetry(event => {
      return log.debug('preset {preset}: retry {attempt} in {delay} ms ({error})', {
        preset,
        attempt: event.attempt,
        delay: event.delay,
        error: describe(event),
      });
    }),
    retry.onGiveUp(reason => {
      return log.debug('preset {preset}: gave up ({error})', { preset, error: describe(reason) });
    }),
    circuitBreaker.onBreak(event => {
      return log.debug('preset {preset}: circuit opened ({error})', {
        preset,
        error: 'isolated' in event ? 'isolated by hand' : describe(event),
      });
    }),
    circuitBreaker.onHalfOpen(() => {
      return log.debug('preset {preset}: circuit half-open', { preset });
    }),
    circuitBreaker.onReset(() => {
      return log.debug('preset {preset}: circuit closed', { preset });
    }),
    timeout.onTimeout(() => {
      return log.debug('preset {preset}: timed out', { preset });
    }),
  );
  if (bulkhead !== undefined) {
    into.push(
      bulkhead.onReject(() => {
        return log.debug('preset {preset}: bulkhead full, call rejected', { preset });
      }),
    );
  }
}

/**
 * Build a DOT plugin that publishes the presets as `services.resilience` and logs their policy
 * events at `debug` under `arki:resilience`.
 *
 * @param presets - The result of `definePresets(...)`. Its names type `for` and `run`.
 */
export function resilience<N extends string>(presets: Presets<N>) {
  return infra({
    name: 'resilience',
    configure(ctx) {
      ctx.registerService('resilience', 'custom');
    },
    provides: {
      resilience: (): ResilienceService<N> => {
        const byName = new Map<string, ResiliencePolicy>(Object.entries<ResiliencePolicy>(presets));
        const lookup = (name: string): ResiliencePolicy => {
          const found = byName.get(name);
          if (found === undefined) {
            throw new DotUnitError({
              code: RESILIENCE_PLUGIN_ERROR_CODES.unknownPreset,
              message: `[resilience] No preset named "${name}". Known: ${[...byName.keys()].join(', ')}.`,
              remediation: 'Use a name you passed to definePresets(...).',
              docsUrl: 'https://arki.dev/dot/errors/arki-resilience-plugin-e001',
            });
          }
          return found;
        };
        const service: ResilienceService<N> = {
          for: lookup,
          run: (name, fn, signal) => lookup(name).execute(fn, signal),
        };

        const made: Subscription[] = [];
        try {
          for (const [name, policy] of byName) listen(name, policy, made);
        } catch (error) {
          for (const subscription of made) subscription.dispose();
          throw error;
        }
        subscriptions.set(service, made);
        return service;
      },
    },
    dispose({ resilience: service }) {
      const made = subscriptions.get(service);
      if (made === undefined) return;
      subscriptions.delete(service);
      for (const subscription of made) subscription.dispose();
    },
  });
}
