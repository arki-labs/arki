AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/ui

## Laws

1. One component, one file, one subpath. A new component gets `src/<name>.tsx` and an `exports` row in `package.json`. There is no root import.
2. Style only with semantic tokens (`bg-background`, `text-muted-foreground`, `border-border`). Never write a raw colour, a Tailwind palette colour (`blue-500`) or a design-system-specific name.
3. Never mix `atelier`, `workbench` and `arena` in one app. Components must look right in every shared system without changes.
4. Do not extend the token contract without founder confirmation. A component that needs a new token stops and asks.
5. Build on `@base-ui/react` primitives. Variants use `class-variance-authority`. Merge classes with `cn` from `src/cn.ts`.
6. A compound part that needs its parent throws a plain `Error` that names the parent. Do not return a silent default.
7. Hooks and components with state start with `'use client'`.
8. Never delete an exported component. This package is a general-purpose product.
9. Use `@arki/theme` for theme state, `@arki/icons` for icons, `@arki/react-hooks` for hooks. Do not copy them in.
10. No `console.log`. Debug output goes through `debug`.

## Changing this package

Edit or add `src/<name>.tsx`. Start the file with a one-line `/** ... */` summary: `llms.txt` reads it. Add the `exports` row (copy a neighbour: `types`, `import`, `browser`). Then run `bun ../../tooling/library/src/llms.ts --write` and add the subpath to the README "Public imports" table. Check the component under all three systems.

## Verify

```sh
bun run typecheck
bun run lint
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
