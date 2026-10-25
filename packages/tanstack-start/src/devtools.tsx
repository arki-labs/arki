/// <reference types="vite/client" />
/**
 * Unified dev-only devtools shell for TanStack Start apps.
 *
 * Mounts the TanStack devtools host with router + query panels (and a
 * built-in Environment panel) as tabs in one floating button. Renders
 * `null` in production — the entire module body is gated by
 * `import.meta.env.DEV` so production bundles tree-shake it away.
 *
 * Usage in `__root.tsx`:
 * ```tsx
 * import { DevTools } from '@arki/tanstack-start/devtools';
 * // ...
 * <Scripts />
 * <DevTools />
 * ```
 *
 * The default behaviour is intentionally non-intrusive:
 *   - trigger button hides until you mouse near the corner (`hideUntilHover`)
 *   - panel opens at the bottom of the viewport
 *   - hotkey `Shift+Alt+D` toggles the panel
 *
 * Apps can override every default via props.
 */
import { Component, lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { createStore } from 'jotai';

import { getLogger } from '@arki/log';

const log = getLogger('arki:tanstack-start');

const isDev = import.meta.env.DEV;

type JotaiStore = ReturnType<typeof createStore>;

const LazyDevToolsImpl = isDev
  ? lazy(() => import('./devtools.impl').then((mod) => ({ default: mod.DevToolsImpl })))
  : null;

type TriggerPosition =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right'
  | 'middle-left'
  | 'middle-right';

export type DevToolsProps = {
  /**
   * Where the floating trigger button lives.
   * @default 'bottom-right'
   */
  position?: TriggerPosition;
  /**
   * Hide the trigger button until the cursor is near it. Less obtrusive
   * during normal use, instantly visible when you reach for it.
   * @default true
   */
  hideUntilHover?: boolean;
  /**
   * Open the devtools panel on first mount. Settings persist in localStorage,
   * so this only applies the first time an app loads.
   * @default false
   */
  defaultOpen?: boolean;
  /**
   * Hotkey to toggle the devtools panel. Pass an array of TanStack devtools
   * KeyboardKey strings (e.g. `['Shift', 'Alt', 'D']` or `['CtrlOrMeta', 'I']`).
   * @default ['Shift', 'Alt', 'D']
   */
  openHotkey?: string[];
  /**
   * Render the panel above or below the page. Bottom is more common.
   * @default 'bottom'
   */
  panelLocation?: 'top' | 'bottom';
  /**
   * Optional Jotai store. When provided, a "Jotai" tab is added to the
   * shell that embeds `jotai-devtools`'s `<DevTools />`. Apps that pass
   * this should remove their inline `<DevTools from 'jotai-devtools'>`
   * mount so only one floating button remains.
   *
   * Pass either a custom store created with `createStore()` from `jotai`,
   * or `undefined` to skip the panel entirely.
   */
  jotaiStore?: JotaiStore;
};

/**
 * Mount inside `__root.tsx` after `<Scripts />`. Returns `null` in production.
 */
export function DevTools(props: DevToolsProps = {}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!isDev || !LazyDevToolsImpl || !mounted) return null;

  return (
    <DevToolsBoundary>
      <Suspense fallback={null}>
        <LazyDevToolsImpl {...props} />
      </Suspense>
    </DevToolsBoundary>
  );
}

/**
 * Keeps a devtools failure inside the devtools. The lazy chunk is large
 * (jotai-devtools alone is ~8 MB in dev), so a proxy that cuts responses short
 * or a stale Vite optimize hash makes its `import()` reject. Without this, the
 * rejection reaches the root route and the whole page stops rendering.
 */
class DevToolsBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    log.warn('Devtools failed to load; the app keeps running without them', { error });
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}
