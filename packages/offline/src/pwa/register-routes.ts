/// <reference lib="webworker" />
import { registerRoute, NavigationRoute, Route } from 'workbox-routing';
import { createStrategy, type FetchStrategy } from './strategies.ts';

export interface AppShellConfig {
  strategy?: 'networkFirst' | 'staleWhileRevalidate';
  maxAgeSeconds?: number;
  cacheName?: string;
}

export interface ApiRouteConfig {
  urlPattern: RegExp;
  strategy: 'networkFirst' | 'staleWhileRevalidate';
  maxAgeSeconds?: number;
  cacheName?: string;
}

export interface StaticAssetConfig {
  urlPattern: RegExp;
  strategy?: Extract<FetchStrategy, 'cacheFirst' | 'staleWhileRevalidate'>;
  cacheName?: string;
}

export interface RegisterOfflineRoutesOptions {
  appShell?: AppShellConfig;
  apiRoutes?: ApiRouteConfig[];
  staticAssets?: StaticAssetConfig[];
}

/**
 * Registers Workbox fetch strategies for app shell, API routes, and static assets.
 *
 * Call this in your service worker file after `import '@fleet/tanstack-start/pwa/sw'`.
 *
 * Invariant: `networkFirst` is the safe default for API routes — it always
 * tries the network, so queued mutations are never "answered" by a stale cache.
 *
 * Cache busting is handled at the strategy level via `cacheName`. Include a
 * build ID suffix in `cacheName` to invalidate on deploy (e.g. `api-v${buildId}`).
 *
 * @example
 * ```ts
 * // src/service-worker.ts
 * import '@fleet/tanstack-start/pwa/sw';
 * import { registerOfflineRoutes } from '@arki/offline/pwa';
 *
 * registerOfflineRoutes({
 *   appShell: { strategy: 'staleWhileRevalidate', cacheName: 'app-shell' },
 *   apiRoutes: [
 *     { urlPattern: /\/rpc\//, strategy: 'networkFirst', maxAgeSeconds: 60, cacheName: 'api' },
 *   ],
 * });
 * ```
 */
export function registerOfflineRoutes(options: RegisterOfflineRoutesOptions = {}): void {
  const { appShell, apiRoutes = [], staticAssets = [] } = options;

  // App shell — navigation requests (HTML document fetches)
  if (appShell) {
    const handler = createStrategy(appShell.strategy ?? 'staleWhileRevalidate', {
      cacheName: appShell.cacheName ?? 'arki-app-shell',
      maxAgeSeconds: appShell.maxAgeSeconds,
    });
    registerRoute(new NavigationRoute(handler));
  }

  // API routes
  for (const route of apiRoutes) {
    const handler = createStrategy(route.strategy, {
      cacheName: route.cacheName ?? 'arki-api',
      maxAgeSeconds: route.maxAgeSeconds,
    });
    registerRoute(new Route(({ url }) => route.urlPattern.test(url.href), handler));
  }

  // Static assets
  for (const asset of staticAssets) {
    const handler = createStrategy(asset.strategy ?? 'cacheFirst', {
      cacheName: asset.cacheName ?? 'arki-static',
    });
    registerRoute(new Route(({ url }) => asset.urlPattern.test(url.href), handler));
  }
}
