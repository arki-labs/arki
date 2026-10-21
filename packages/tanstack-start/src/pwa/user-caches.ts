/**
 * Keep one user's offline caches away from the next user on the same device.
 * Re-exported from `@arki/tanstack-start/pwa/client`.
 */

import { useEffect } from 'react';

/** The Cache Storage cache that remembers which user the other caches were filled for. */
const CACHE_OWNER_CACHE = 'pwa-cache-owner';
/** The one entry in {@link CACHE_OWNER_CACHE}; its body is the user id and nothing else. */
const CACHE_OWNER_KEY = '/__pwa-cache-owner';
/** Workbox names its precache `workbox-precache-v2-<scope>`: built static files, the same for every user. */
const PRECACHE_PREFIX = 'workbox-precache';

/**
 * Delete the service worker's user-tied caches when the signed-in user is not
 * the one they were filled for.
 *
 * The service worker keeps pages and API answers so they work offline, and
 * those hold the signed-in user's data. Call this with the user id whenever
 * the session is known, and with `null` on sign-out and account deletion. It
 * deletes every cache except the Workbox precache (built static files) when
 * the user differs from the one recorded, which covers a sign-out, a deleted
 * account, and a new session that replaced an expired one without a sign-out.
 *
 * Who filled the caches is recorded in Cache Storage itself, so it survives
 * a sign-out and lives and dies with the caches it describes. It holds only
 * the user id. Without Cache Storage (no service worker support, insecure
 * origin) there is nothing to delete, and this does nothing.
 */
export async function clearCachesOnUserChange(userId: string | null): Promise<void> {
  if (typeof caches === 'undefined') return;
  const ownerCache = await caches.open(CACHE_OWNER_CACHE);
  const ownerEntry = await ownerCache.match(CACHE_OWNER_KEY);
  const owner = ownerEntry === undefined ? null : await ownerEntry.text();
  if (owner === userId) return;

  const names = await caches.keys();
  await Promise.all(
    names
      .filter(name => name !== CACHE_OWNER_CACHE && !name.startsWith(PRECACHE_PREFIX))
      .map(name => caches.delete(name)),
  );
  if (userId === null) await ownerCache.delete(CACHE_OWNER_KEY);
  else await ownerCache.put(CACHE_OWNER_KEY, new Response(userId));
}

/**
 * Run {@link clearCachesOnUserChange} whenever the session's user changes.
 * Pass `undefined` while the session is still loading, so a page that has not
 * learned who is signed in never clears the caches.
 */
export function useClearCachesOnUserChange(userId: string | null | undefined): void {
  useEffect(() => {
    if (userId === undefined) return;
    void clearCachesOnUserChange(userId);
  }, [userId]);
}
