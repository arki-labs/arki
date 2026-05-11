/// <reference lib="webworker" />

/**
 * Shared service-worker base for TanStack Start apps.
 *
 * Each app's `src/service-worker.ts` should `import` this module as a
 * side-effect. Apps that need extra behaviour (push notifications, custom
 * fetch handlers, background sync) can add their own listeners after the
 * import.
 *
 * @example
 * ```ts
 * // apps/myapp/start/src/service-worker.ts
 * import '@arki/tanstack-start/pwa/sw';
 * ```
 */

import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);
