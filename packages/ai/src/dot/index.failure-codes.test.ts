/**
 * The `vectorIndex` Dot unit fails boot with the typed env failure. WHY it matters: a bad `QDRANT_*`
 * value must stop the app at boot with a fixable `env.invalid_environment`, not surface as NaN at the
 * first collection call.
 */
import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot/unit';
import { isFailure } from '@arki/failure';

import { vectorIndex } from './index';

type Payload = { userId: string };

describe('vectorIndex() boot', () => {
  it('fails boot with InvalidEnvironment when a QDRANT_* value is not valid', async () => {
    const booted = await defineApp('vi-bad-env')
      .infra(
        vectorIndex<Payload>({
          collection: 'test',
          payloadIndexes: [],
          space: {
            provider: 'fake',
            model: 'fake-4',
            dimensions: 4,
            normalized: true,
            quantization: 'float32',
            instructionVersion: 0,
          },
          env: () => ({ QDRANT_URL: 'http://q:6333', QDRANT_REPLICATION_FACTOR: 'abc' }),
        }),
      )
      .boot();

    expect(isFailure(booted) && booted.code).toBe('env.invalid_environment');
  });
});
