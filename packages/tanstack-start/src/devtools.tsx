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
import { lazy, Suspense, useEffect, useState } from 'react';

const isDev = import.meta.env.DEV;

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
    <Suspense fallback={null}>
      <LazyDevToolsImpl {...props} />
    </Suspense>
  );
}
