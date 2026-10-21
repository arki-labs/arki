AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/chat-ui

## Laws

1. Every component file starts with `'use client'`. This is a browser package; nothing here runs on a bare Node server without a React renderer.
2. One component per subpath export, one file per component. Add the export to `package.json` `exports` and `typesVersions` together.
3. Components wrap `@assistant-ui/react` primitives or plain elements. They do not own chat state. The runtime comes from the app.
4. Style with `@arki/ui` tokens and `cn` from `@arki/ui/cn`. No hard-coded colours; use semantic classes.
5. Every root element sets a `data-slot="chat-..."` attribute and spreads the remaining props.
6. Types come from `src/types.ts` or from the source they describe (`@arki/ai`'s `RuntimeUiState`). Never copy a type here.
7. Icons come from `@arki/icons/phosphor`.
8. Markdown parsing is the consumer's job. Take a `renderText` prop; do not add a markdown dependency.
9. `useToolRegistry` outside a provider throws. Do not return a silent default.
10. `sideEffects` lists only CSS. A new file with a side effect needs a package.json change.

## Changing this package

- New component: `src/<name>.tsx` with JSDoc and an `@example`, then the exports and `typesVersions` entries, then `bun ../../tooling/library/src/llms.ts --write`.
- Keep the Quick start in `README.md` in step with `examples/render-agent-run.tsx`. Run `bun run test:docs -- --write` to refresh `from=` fences.
- A new animation goes in `src/styles/chat.css` inside `@theme inline`.
- `STRATEGY.md` is an internal design note. It is not shipped. Do not link it from the README.
- Keep `README.md`, `llms.txt`, `docs/agent-guide.md` and `docs/components.md` in step.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
