AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/theme

## Laws

1. The provider never throws. A missing provider, a blocked `localStorage` and an unknown stored value all fall back to a default. Keep it that way.
2. `src/script.ts` must stay free of imports. `themeScript()` turns `themeDetectionFn` into a string with `toString()`, so the function cannot use anything outside itself.
3. The provider and `themeDetectionFn` apply the theme in the same way (same class names, `dark` and `is-dark`, `color-scheme`). Change one, change the other in the same commit.
4. `'use client'` stays on `src/index.ts` and `src/theme-context.tsx`. `src/script.ts` has none: it runs on the server.
5. The default storage key is `theme`. Read it from `THEME_STORAGE_KEY`, never retype it.
6. `@arki/theme` has no `@arki/*` dependency. Only `react` is a peer.

## Changing this package

Edit `src/`. Run Verify. If you change a default (`defaultTheme`, `attribute`, `themes`), update the README "Limits" section and the script options together.

## Verify

```sh
bun run typecheck
bun run lint
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
