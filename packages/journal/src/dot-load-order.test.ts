/**
 * Why: `needsOf((_: Deps) => [...])` never reads the feature's value, so a reaction module and its
 * feature module must work whichever one a caller imports first. A selector that read the feature at
 * import time would see an unfinished module in one of the two orders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mailer = { send: (id: string) => void id };

describe('a reaction module and its feature module', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('works when the reaction is imported first', async () => {
    const { sendReceipt } = await import('./fixtures/load-order/reaction.test-d.js');
    const { reactions } = await import('./fixtures/load-order/feature.test-d.js');
    expect(Object.keys(sendReceipt.needs)).toEqual(['mailer']);
    expect(() => reactions.bind({ mailer })).not.toThrow();
  });

  it('works when the feature is imported first', async () => {
    const { reactions } = await import('./fixtures/load-order/feature.test-d.js');
    const { sendReceipt } = await import('./fixtures/load-order/reaction.test-d.js');
    expect(Object.keys(sendReceipt.needs)).toEqual(['mailer']);
    expect(() => reactions.bind({ mailer })).not.toThrow();
  });

  it('refuses to bind a feature that lacks the picked dep, naming it', async () => {
    const { reactions } = await import('./fixtures/load-order/feature.test-d.js');
    // @ts-expect-error -- type test: these deps have no `mailer`
    expect(() => reactions.bind({})).toThrow('needs "mailer"');
  });
});
