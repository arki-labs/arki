import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdGenerationFailure } from '@arki/contracts';
import { RandomSourceUnavailable } from '@arki/contracts';
import { UnexpectedDefect } from '@arki/failure';

import {
  attemptId,
  commandId,
  correlationId,
  eventId,
  jobId,
  leaseToken,
  operationId,
  workflowRunId,
  workflowSignalId,
} from './id.js';

afterEach(() => vi.unstubAllGlobals());

describe('journal ID generation', () => {
  it.each([
    ['evt_', eventId],
    ['job_', jobId],
    ['cmd_', commandId],
    ['cor_', correlationId],
    ['att_', attemptId],
    ['jop_', operationId],
    ['wfr_', workflowRunId],
    ['wsg_', workflowSignalId],
    ['', leaseToken],
  ] as const)('preserves the stored %s prefix and 24-character body', (prefix, create) => {
    expect(create()).toMatch(new RegExp(`^${prefix}[a-z][a-z0-9]{23}$`));
  });

  it('returns the original unavailable-entropy definition', () => {
    vi.stubGlobal('crypto', null);
    expect(RandomSourceUnavailable.is(jobId())).toBe(true);
    expectTypeOf(jobId()).toEqualTypeOf<`job_${string}` | IdGenerationFailure>();
  });

  it('returns the original defect definition when the provider throws', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: () => {
        throw new Error('private provider fault');
      },
    });
    expect(UnexpectedDefect.is(eventId())).toBe(true);
  });
});
