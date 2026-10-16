import { createIdbPersister } from '@arki/offline/query';

/**
 * IDB persister for the TanStack Query cache.
 *
 * Pass this to PersistedQueryClientProvider (wired in lib/orpc/client.tsx)
 * to enable Tier 1 offline support — reads survive page reloads and short
 * network outages.
 *
 * For Tier 2 (queued offline writes), see @arki/offline/mutations and
 * @arki/offline/preset docs. Tier 2 requires backend idempotency — mark each
 * queued procedure `offlineSafe(p)` on its contract (@arki/offline/orpc) and
 * install `idempotency(repo)` once on the server's implementer.
 */
export const idbPersister = createIdbPersister({
  storageKey: 'arki-query',
});
