AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/dot — Laws

Rules for code in this package and for apps built on it. Each law names the
check that enforces it. Read [docs/principles.md](docs/principles.md) for the
reasons behind them.

## Laws

1. **Plugins are the app.** There is no hidden core: no built-in service, no
   hook outside `configure → boot → start → stop → dispose`, no plugin
   auto-loaded from disk. A service exists only because a plugin provides it
   (principle 2).
2. **`configure` is synchronous and does no I/O.** A `configure` that returns
   a Promise fails with `ARKI_DOT_E001`. Async work goes in `boot` or in a
   `provides` factory. This is what keeps `dot explain` free of side effects.
3. **Providers before consumers.** Declaration order is boot order; nothing
   sorts it. The wrong order is a compile error at `.use()`, and
   `ARKI_DOT_E020` (or `ARKI_DOT_E012`) when the types are erased. Never
   "fix" it with a sort.
4. **Never cast a manifest.** Read it with `.configure().manifest` on a
   builder or `app.manifest` on a booted app. No `as`, no `as unknown as`:
   the manifest types are exported, and a cast hides a wrong path until an
   agent reads `null`.
5. **The kernel imports no adapter.** `src/**` never imports `@arki/db`,
   `@arki/env`, `@arki/kv`, `@arki/journal` or any other adapter. Adapters
   take `@arki/dot` as an optional peer and live in their own packages
   (principle 5). `@orpc/server` is loaded only by `@arki/dot/orpc`.
6. **Error codes are API.** Managed construction/disposal returns inferred typed failures under A-33; static declaration/configure defects may throw. Owned resources and child tasks must settle before finalization. Every legacy kernel error has a stable `ARKI_DOT_E*`
   code, a `remediation` and a `docsUrl`. Codes are never renumbered or
   reused (E009 and E010 are retired). Each code's JSDoc carries `@fix` and
   `@verify`.
7. **Deterministic.** Same source, same manifest, byte for byte. No clock,
   no random id and no host ordering inside the manifest (principle 3).

## Changing this package

- A new error code takes the next free number, a JSDoc summary, `@fix`,
  `@verify`, a row in the README `Failure behaviour` table and a row in the
  agent guide `Errors` table.
- A new public export gets a JSDoc example and a test; a new entry gets a
  one-sentence top comment, then `bun ../../tooling/library/src/llms.ts --write`.
- A change to `--json` output keeps every `jq` path in
  `docs/agent-guide.md` valid (`src/cli/json-paths.test.ts` checks them).
- Docs follow the Dot style: small files, a diagram where it helps, every
  decision with its reason. Command output comes from `ts run expect`
  blocks or `from=` regions, never pasted by hand.
- `docs/plans/**` is internal and does not ship (`!docs/plans/**` in
  `files`).

## Consuming it

- Start from the [Quickstart](docs/quickstart.md), then the
  [agent guide](docs/agent-guide.md) task map.
- In an app, check wiring with `dot explain --json` (no side effects) and
  boot with `dot doctor --json` (boots and disposes; never calls `start`).

## Verify

Run in `packages/dot`:

```sh
bun run build
bun run test:docs
bun run typecheck
bun run test
bun run lint
bun ../../tooling/library/src/llms.ts --check
bun ../../tooling/library/src/error-index.ts
```

The last line must report `0 without @fix/@verify`.
