/** usecases/: declares what it needs by the adapters' own types — the one type-only import from infra/. */
import type { Provided } from '../../../../plugin.js';
import type { billing } from '../infra.js';
import type { store } from './store.js';

type Store = Provided<typeof store.provides.store>;
type Plans = Provided<typeof billing.provides.entitlements>;

export const createUsecases = ({ store, plans }: { store: Store; plans: Plans }) => ({
  preview: async (userId: string) => {
    const pending = await store.pendingFor(userId);
    const cap = (await plans.planOf(userId)) === 'pro' ? 25 : 3;
    return { ...pending, items: pending.items.slice(0, cap) };
  },
});
