/// <reference lib="webworker" />
import '@arki/tanstack-start/pwa/sw';
import { registerOfflineRoutes } from '@arki/offline/pwa';

/**
 * Register fetch strategies for offline support.
 *
 * - App shell: staleWhileRevalidate — fast loads, eventually fresh
 * - API routes: networkFirst — always try the network, cache as fallback
 *
 * Add more urlPattern entries for any additional API namespaces.
 * See @arki/offline/pwa docs for cacheName, maxAgeSeconds, and strategy options.
 */
registerOfflineRoutes({
  appShell: {
    strategy: 'staleWhileRevalidate',
    cacheName: 'arki-app-shell',
  },
  apiRoutes: [
    {
      urlPattern: /\/api\//,
      strategy: 'networkFirst',
      maxAgeSeconds: 60,
      cacheName: 'arki-api',
    },
  ],
});
