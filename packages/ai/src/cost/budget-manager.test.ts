import { describe, expect, test, vi } from 'vitest';

import type { KVStore } from './types';
import { BudgetExceeded } from '../failures';
import { BudgetManager } from './budget-manager';

function memoryKv(): KVStore {
  const values = new Map<string, unknown>();
  return {
    get: vi.fn().mockImplementation((key: string) => Promise.resolve(values.get(key) ?? null)),
    set: vi.fn().mockImplementation((key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn().mockImplementation((key: string) => {
      values.delete(key);
      return Promise.resolve();
    }),
  };
}

function manager() {
  return new BudgetManager(memoryKv(), { limits: { hourly: 1, daily: 10, monthly: 100 } });
}

describe('BudgetManager.checkBudget', () => {
  test('returns nothing while every period has room, so the caller just goes on', async () => {
    const budgets = manager();
    await budgets.recordSpend('usr_1', 0.25);

    expect(await budgets.checkBudget('usr_1', 0.5)).toBeUndefined();
  });

  test('returns BudgetExceeded naming the period that would go over, with what is spent and what is left', async () => {
    const budgets = manager();
    await budgets.recordSpend('usr_1', 0.8);

    const result = await budgets.checkBudget('usr_1', 0.5);

    expect(BudgetExceeded.is(result)).toBe(true);
    if (!BudgetExceeded.is(result)) return;
    expect(result.code).toBe('ai.budget_exceeded');
    expect(result.status).toBe(402);
    expect(result.data.period).toBe('hourly');
    expect(result.data.currentSpendUsd).toBeCloseTo(0.8);
    expect(result.data.remainingUsd).toBeCloseTo(0.2);
  });

  test('never reports a negative remaining amount once a period is already over its limit', async () => {
    const budgets = manager();
    await budgets.recordSpend('usr_1', 1.5);

    const result = await budgets.checkBudget('usr_1', 0.01);

    expect(BudgetExceeded.is(result) && result.data.remainingUsd).toBe(0);
  });
});

describe('BudgetManager.recordSpend under concurrency (F18)', () => {
  test('never loses a spend when calls for the same user overlap', async () => {
    // WHY: two overlapping calls used to read the same old total and both write total + own cost,
    // so one spend vanished and the user could overspend their budget.
    const values = new Map<string, unknown>();
    const kv: KVStore = {
      // A real store answers after a round trip; the delay lets the two read-modify-writes interleave.
      get: vi.fn().mockImplementation(async (key: string) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return values.get(key) ?? null;
      }),
      set: async (key, value) => {
        await new Promise(resolve => setTimeout(resolve, 5));
        values.set(key, value);
      },
      delete: async key => {
        values.delete(key);
      },
    };
    const budgets = new BudgetManager(kv, { limits: { hourly: 100, daily: 100, monthly: 100 } });

    await Promise.all([budgets.recordSpend('usr_1', 1), budgets.recordSpend('usr_1', 2), budgets.recordSpend('usr_1', 3)]);

    expect(await budgets.getCurrentSpend('usr_1', 'hourly')).toBe(6);
    expect(await budgets.getCurrentSpend('usr_1', 'monthly')).toBe(6);
  });
});

describe('BudgetManager.getBudgetStatus with a zero limit (F18)', () => {
  test('reports 0 % while nothing is spent, never NaN', async () => {
    const budgets = new BudgetManager(memoryKv(), { limits: { hourly: 0, daily: 10, monthly: 100 } });

    const statuses = await budgets.getBudgetStatus('usr_1');
    const hourly = statuses.find(status => status.period === 'hourly');

    expect(hourly?.percentUsed).toBe(0);
  });

  test('reports 100 % once anything is spent against a zero limit', async () => {
    const budgets = new BudgetManager(memoryKv(), { limits: { hourly: 0, daily: 10, monthly: 100 } });
    await budgets.recordSpend('usr_1', 0.5);

    const statuses = await budgets.getBudgetStatus('usr_1');
    const hourly = statuses.find(status => status.period === 'hourly');

    expect(hourly?.percentUsed).toBe(100);
  });
});
