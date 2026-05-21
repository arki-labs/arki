import { createIdbPersister } from '@arki/offline/query';

/**
 * IDB persister for the TanStack Query cache.
 *
 * Pass this to PersistedQueryClientProvider (wired in lib/orpc/client.tsx)
 * to enable Tier 1 offline support — reads survive page reloads and short
 * network outages.
 *
 * For Tier 2 (queued offline writes), see @arki/offline/mutations and
 * @arki/offline/preset docs. Tier 2 requires backend idempotency — every
 * queued mutation must be marked with .use(offlineSafe()) on the server.
 */
export const idbPersister = createIdbPersister({
  storageKey: 'arki-query',
});
