/**
 * Unified dev-only devtools shell for TanStack Start apps.
 *
 * Mounts the TanStack devtools host with router + query panels as tabs, and
 * (optionally) initializes Spotlight for source-mapped error capture.
 *
 * Renders nothing in production — the entire module body is gated by
 * `import.meta.env.DEV` so production bundles tree-shake it away.
 *
 * Usage in `__root.tsx`:
 * ```tsx
 * import { DevTools } from '@arki/tanstack-start/devtools';
 * // ...
 * <Scripts />
 * <DevTools />
 * ```
 */
import { lazy, Suspense, useEffect, useState } from 'react';

const isDev = import.meta.env.DEV;

const LazyDevToolsImpl = isDev
  ? lazy(() => import('./devtools.impl').then((mod) => ({ default: mod.DevToolsImpl })))
  : null;

export type DevToolsProps = {
  /**
   * Override the default initial position of the devtools trigger button.
   * @default 'bottom-right'
   */
  position?: 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left';
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
