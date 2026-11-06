/**
 * Inside a Dot app, a preset run by a usecase opens its `resilience.execute`
 * span under the usecase's span. So a trace shows which usecase retried or
 * timed out, not a free-floating policy span.
 */
import { describe, expect, it } from 'vitest';

import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { resilience } from './dot.js';
import { backoff, definePresets } from './index.js';

const presets = definePresets({ carrier: { retry: backoff.constant(0).upTo(1) } });
const carrier = resilience(presets);

const shipping = defineFeature('shipping')
  .needs({ resilience: carrier.provides.resilience })
  .usecases({
    quote:
      ({ resilience: policies }) =>
      () =>
        policies.run('carrier', () => 42),
  })
  .entrypoints();

describe('@arki/resilience spans inside a Dot app', () => {
  it('nests resilience.execute under the Dot usecase span, so a trace shows which usecase ran the policy', async () => {
    using spans = captureSpans();
    const app = orThrow(await defineApp('resilience-telemetry').infra(carrier).features([shipping]).start());
    try {
      expect(await app.services['shipping.usecases'].quote()).toBe(42);
    } finally {
      orThrow(await app.dispose());
    }

    const execute = spans.named('resilience.execute');
    expect(execute.parent).toBe(spans.named('feature.shipping.quote'));
    expect(spans.named('resilience.attempt').parent).toBe(execute);
  });
});
