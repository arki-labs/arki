AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/icons

## Laws

1. This package picks and wraps icon sets. It does not draw icons. Never add a hand-drawn icon here.
2. `@arki/icons` (the root) is Phosphor and nothing else. Other sets live on their own subpath, so a Phosphor-only app never loads them.
3. Each design system has one defaults provider in `src/phosphor-defaults.tsx`. Changing a weight or size there changes every app on that system. Ask the founder first.
4. `src/home.ts` uses `~icons/...`, which only `unplugin-icons` resolves. Keep it off the root entry and off any entry that apps import by default.
5. `Flag` assumes the app serves `/flags/<size>/<code>.svg`. Do not change that path without changing the README "Limits" section.
6. Never delete an export. Libraries here are general-purpose products.
7. No `@arki/*` dependency. `react` stays a peer.

## Changing this package

Edit `src/`. Every entry module starts with a one-line `/** ... */` summary, because `llms.txt` reads it. A new entry needs an `exports` row in `package.json`, a README "Public imports" row, and `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run typecheck
bun run lint
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
