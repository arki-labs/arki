/// <reference types="vite-plugin-pwa/client" />

/**
 * Register the app's service worker.
 *
 * Call this once from `entry-client.tsx` after `hydrateRoot`. Safe to call
 * in non-browser contexts: the function bails out when `navigator` or the
 * `serviceWorker` API is unavailable.
 *
 * @example
 * ```tsx
 * // apps/myapp/start/src/entry-client.tsx
 * import { registerPwa } from '@arki/tanstack-start/pwa/client';
 * registerPwa();
 * ```
 */

import { registerSW } from 'virtual:pwa-register';

export type RegisterPwaOptions = {
  /** Apply pending updates without waiting for a reload. Default: true. */
  immediate?: boolean;
  /** Called when a new SW version is waiting to take over. */
  onNeedRefresh?: () => void;
  /** Called when the SW has finished its first install. */
  onOfflineReady?: () => void;
  /** Called once the SW script has registered. */
  onRegisteredSW?: (
    swScriptUrl: string,
    registration: ServiceWorkerRegistration | undefined,
  ) => void;
  /** Called when registration fails. */
  onRegisterError?: (error: unknown) => void;
};

export function registerPwa(options: RegisterPwaOptions = {}): void {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;
  registerSW({ immediate: true, ...options });
}
