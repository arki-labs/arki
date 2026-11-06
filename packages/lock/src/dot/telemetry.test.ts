/**
 * Inside a Dot app, a lock taken by a usecase opens its `lock.run` span under
 * the usecase's span. So a trace shows which usecase held the lock, and how
 * long it waited.
 */
import { describe, expect, it } from 'vitest';

import { defineFeature } from '@arki/dot/feature';
import { defineApp } from '@arki/dot/unit';
import { orThrow } from '@arki/failure';
import { captureSpans } from '@arki/testing/otel';

import { memoryStore } from '../memory.js';
import { locks } from './index.js';

const lockUnit = locks({ namespace: 'test', store: () => memoryStore() });

const billing = defineFeature('billing')
  .needs({ locks: lockUnit.provides.locks })
  .usecases({
    closeBooks:
      ({ locks: held }) =>
      () =>
        held.mutex('close-books').run(() => Promise.resolve('closed')),
  })
  .entrypoints();

describe('@arki/lock spans inside a Dot app', () => {
  it('nests lock.run under the Dot usecase span, so a trace shows which usecase held the lock', async () => {
    using spans = captureSpans();
    const app = orThrow(await defineApp('lock-telemetry').infra(lockUnit).features([billing]).start());
    try {
      expect(await app.services['billing.usecases'].closeBooks()).toBe('closed');
    } finally {
      orThrow(await app.dispose());
    }

    expect(spans.named('lock.run').parent).toBe(spans.named('feature.billing.closeBooks'));
  });
});
