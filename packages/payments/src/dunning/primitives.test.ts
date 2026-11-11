/**
 * The dunning id factories: an id with its prefix when entropy works, and the typed
 * `contracts.random_source_unavailable` failure when no secure random source exists, never a weak id.
 * Only the random source is stood in, as core/primitives.test.ts does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RandomSourceUnavailable } from '@arki/contracts';

import {
  createCustomerRiskProfileId,
  createCustomerSegmentId,
  createDunningCampaignId,
  createDunningCommunicationId,
  createDunningExecutionId,
  createDunningTemplateId,
} from './primitives.js';

const factories = [
  ['createDunningCampaignId', createDunningCampaignId],
  ['createDunningTemplateId', createDunningTemplateId],
  ['createDunningExecutionId', createDunningExecutionId],
  ['createDunningCommunicationId', createDunningCommunicationId],
  ['createCustomerSegmentId', createCustomerSegmentId],
  ['createCustomerRiskProfileId', createCustomerRiskProfileId],
] as const;

describe('dunning id factories', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(factories)('%s returns an id when entropy works', (_name, create) => {
    const id = create();
    expect(RandomSourceUnavailable.is(id)).toBe(false);
    expect(typeof id).toBe('string');
  });

  it.each(factories)(
    '%s returns contracts.random_source_unavailable when no secure random source exists, never a weak id',
    (_name, create) => {
      vi.stubGlobal('crypto', null);
      const result = create();
      expect(RandomSourceUnavailable.is(result)).toBe(true);
      expect(result).toMatchObject({ code: 'contracts.random_source_unavailable' });
    },
  );
});
