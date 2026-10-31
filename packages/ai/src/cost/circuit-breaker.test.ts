/**
 * The cost circuit breaker: an open breaker is a returned `ai.circuit_open` failure, and only a
 * real outage (a returned provider failure) counts toward tripping it. A caller who gives up, or a
 * bug, must never lock every user out of the AI.
 */
import { describe, expect, it } from 'vitest';

import { UnexpectedDefect } from '@arki/failure';

import { Cancelled, CircuitOpen, ProviderFailed } from '../failures';
import { CostCircuitBreaker } from './circuit-breaker';

const outage = () => Promise.resolve(ProviderFailed({ provider: 'openai', model: 'gpt-4o', status: 503 }));

describe('CostCircuitBreaker.execute', () => {
  it('returns the operation result while closed, and adds its cost', async () => {
    const breaker = new CostCircuitBreaker({ costThresholdUsd: 10 });

    expect(await breaker.execute(() => Promise.resolve('answer'), 2)).toBe('answer');
    expect(breaker.getCumulativeCost()).toBe(2);
  });

  it('returns CircuitOpen (cost_threshold) and does not run a call that would cross the cost threshold', async () => {
    // WHY: the breaker exists to stop spending; the expensive call must not run at all.
    const breaker = new CostCircuitBreaker({ costThresholdUsd: 1, timeoutSeconds: 60 });
    let ran = false;

    const result = await breaker.execute(() => {
      ran = true;
      return Promise.resolve('answer');
    }, 5);

    expect(ran).toBe(false);
    expect(CircuitOpen.is(result)).toBe(true);
    if (!CircuitOpen.is(result)) return;
    expect(result.code).toBe('ai.circuit_open');
    expect(result.status).toBe(503);
    expect(result.data.reason).toBe('cost_threshold');
    expect(result.data.costThresholdUsd).toBe(1);
    expect(result.data.retryAfterMs).toBeGreaterThan(0);
    expect(result.data.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('opens after failureThreshold returned outages, then returns CircuitOpen (open) without running the call', async () => {
    const breaker = new CostCircuitBreaker({ failureThreshold: 2 });

    expect(ProviderFailed.is(await breaker.execute(outage))).toBe(true);
    expect(ProviderFailed.is(await breaker.execute(outage))).toBe(true);
    expect(breaker.isOpen()).toBe(true);

    let ran = false;
    const result = await breaker.execute(() => {
      ran = true;
      return Promise.resolve('answer');
    });
    expect(ran).toBe(false);
    expect(CircuitOpen.is(result) && result.data.reason).toBe('open');
  });

  it('does not count a returned Cancelled toward opening the breaker', async () => {
    // WHY: a user closing the tab is not an outage; aborts must not lock other calls out.
    const breaker = new CostCircuitBreaker({ failureThreshold: 1 });

    const result = await breaker.execute(() => Promise.resolve(Cancelled()));

    expect(Cancelled.is(result)).toBe(true);
    expect(breaker.isClosed()).toBe(true);
  });

  it('maps a thrown abort to Cancelled and does not count it', async () => {
    const breaker = new CostCircuitBreaker({ failureThreshold: 1 });

    const result = await breaker.execute(() => Promise.reject(new DOMException('aborted', 'AbortError')));

    expect(Cancelled.is(result) && result.code).toBe('ai.cancelled');
    expect(breaker.isClosed()).toBe(true);
  });

  it('maps any other throw to UnexpectedDefect, keeps the thrown value as cause, and does not count it', async () => {
    // WHY: a bug is not an outage; it must not lock every user out of the AI.
    const breaker = new CostCircuitBreaker({ failureThreshold: 1 });
    const bug = new TypeError('cannot read properties of undefined');

    const result = await breaker.execute(() => Promise.reject(bug));

    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(UnexpectedDefect.is(result) && result.cause).toBe(bug);
    expect(breaker.isClosed()).toBe(true);
  });

  it('does not count a returned UnexpectedDefect toward opening the breaker', async () => {
    const breaker = new CostCircuitBreaker({ failureThreshold: 1 });

    const result = await breaker.execute(() => Promise.resolve(UnexpectedDefect({ cause: new Error('bug') })));

    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(breaker.isClosed()).toBe(true);
  });
});
