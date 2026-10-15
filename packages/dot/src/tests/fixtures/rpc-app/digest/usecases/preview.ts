/**
 * usecases/preview.ts: one usecase, one file. It asks only for what it uses
 * (`Pick<Deps, …>`); `Deps` is `import type`, so this file never loads `feature.ts`.
 */
import type { Deps } from '../feature.js';

export const preview =
  ({ store, plans }: Pick<Deps, 'store' | 'plans'>) =>
  async (userId: string) => {
    const pending = await store.pendingFor(userId);
    const cap = (await plans.planOf(userId)) === 'pro' ? 25 : 3;
    return { ...pending, items: pending.items.slice(0, cap) };
  };
