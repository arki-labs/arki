AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/ui

## Laws

1. One component, one file, one subpath. A new component gets `src/<name>.tsx` and an `exports` row in `package.json`. There is no root import.
2. Style only with semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`). Never write a raw colour, a Tailwind palette colour (`blue-500`) or a design-system-specific name.
3. Never mix two themes in one app. Components must look right with any shadcn-compatible theme without changes.
4. Do not extend the token contract without founder confirmation. A component that needs a new token stops and asks.
5. Build on `@base-ui/react` primitives. Variants use `class-variance-authority`. Merge classes with `cn` from `src/cn.ts`.
6. A compound part that needs its parent throws a plain `Error` that names the parent. Do not return a silent default.
7. Hooks and components with state start with `'use client'`.
8. Never delete an exported component. This package is a general-purpose product.
9. Use `@arki/ui/theme` (this package) for theme state, `@arki/icons` for icons, `@arki/ui/hooks/*` (this package) for hooks. Do not copy them in.
10. No `console.log`. Debug output goes through `debug`.
11. `src/theme/script.ts` imports nothing. `themeScript()` turns `themeDetectionFn` into a string with `toString()`, so the function cannot use anything outside itself. It has no `'use client'`: it runs on the server.
12. `ThemeProvider` and `themeDetectionFn` apply the theme the same way (the `dark` and `is-dark` classes, `color-scheme`). Change one, change the other in the same commit. Theme code never throws; every bad input falls back to a default.

## Changing this package

Edit or add `src/<name>.tsx`. Start the file with a one-line `/** ... */` summary: `llms.txt` reads it. Add the `exports` row (copy a neighbour: `types`, `import`, `browser`). Then run `bun ../../tooling/library/src/llms.ts --write` and add the subpath to the README "Public imports" table. Check the component under all three systems.

## Verify

```sh
bun run typecheck
bun run lint
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
