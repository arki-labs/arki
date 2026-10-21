/// <reference types="vite/client" />
/**
 * Jotai panel for the unified devtools shell.
 *
 * Wraps `jotai-devtools`'s `<DevTools />` so it can mount as a tab inside
 * `<TanStackDevtools>` instead of as its own floating shell.
 *
 * Why this wrapper exists:
 *
 *   - `jotai-devtools` doesn't expose a panel-only/headless component;
 *     `<DevTools />` always renders both a trigger button AND a panel.
 *     We render the whole thing with `isInitialOpen` so the panel is open
 *     immediately, then hide its trigger button via scoped CSS so users
 *     only see the single TanStack devtools trigger.
 *
 *   - `jotai-devtools/styles.css` must be imported once per app for the
 *     panel to look right. We do it inside this module — the module is
 *     only loaded by `devtools.impl.tsx`, which is lazy-loaded behind
 *     `import.meta.env.DEV`, so production bundles strip the styles
 *     along with the rest.
 */
import { DevTools as JotaiDevTools } from 'jotai-devtools';
import type { createStore } from 'jotai';

// Side-effect import — Jotai devtools' panel needs its own stylesheet to
// render correctly. Typed via `vite/client` (see vite-env.d.ts). The file
// is only loaded inside this dev-only module so it never reaches
// production bundles.
import 'jotai-devtools/styles.css';

const HIDE_INNER_TRIGGER_STYLES = `
  .jotai-devtools-trigger-button { display: none !important; }
`;

type JotaiStore = ReturnType<typeof createStore>;

export function JotaiPanel({ store }: { store?: JotaiStore }) {
  return (
    <>
      <style>{HIDE_INNER_TRIGGER_STYLES}</style>
      <JotaiDevTools isInitialOpen store={store} theme="dark" />
    </>
  );
}
