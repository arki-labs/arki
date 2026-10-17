AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/react-hooks

## Laws

1. One hook family, one file, one subpath. A new hook gets `src/<name>.tsx` and an entry in `package.json` `exports`. There is no root import, so apps pull in only what they use.
2. Prefer a re-export (`export { x } from '@mantine/hooks'`) to a copy. Write a new hook only when no wrapped library has it.
3. A hook never throws and never touches `window` or `document` while rendering. Browser access goes inside `useEffect`, or behind a `typeof window` check, so server rendering works.
4. A hook that reads the browser starts with the server value and updates after the first effect. Document that value in the README "Failure behaviour" section.
5. Hooks that use state or effects start with `'use client'`.
6. Dependencies are the wrapped libraries only (`@mantine/hooks`, `usehooks-ts`, `react-hotkeys-hook`, `@rehooks/local-storage`, `@reecelucas/react-use-hotkeys`). No `@arki/*` dependency. `react` stays a peer.
7. Never delete a public hook. This package is a general-purpose product.

## Changing this package

Edit or add `src/<name>.tsx`. Start the file with a one-line `/** ... */` summary: `llms.txt` reads it. Add the subpath to `exports` and to the README "Public imports". Regenerate the map with `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run typecheck
bun run lint
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
