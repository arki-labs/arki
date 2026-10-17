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
