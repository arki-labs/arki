AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/env

## Laws

1. One `defineEnv` per app. Declare every variable there. Do not read `process.env` anywhere else.
2. Validation runs in every environment. The only implicit opt-out is `SKIP_ENV_VALIDATION=1`, exactly `1`, in build stages without secrets. Never add another skip rule.
3. Wrap every secret in `secret(...)`. Read it with `reveal(...)` at the one call that needs the raw string. Never log a revealed value.
4. A schema is any Standard Schema and validates synchronously. Do not add a Zod-only code path.
5. Nothing reads the environment at import. Keep it lazy: the first property read validates.
6. The package must run without `process` (Hermes, browsers). Read `globalThis.process?.env`, never the bare `process` global.
7. A bad environment fails loud: a thrown `Error` from `defineEnv`, or `ARKI_ENV_PLUGIN_E001` from the Dot plugin. Never fall back to defaults after a failure.
8. The Dot adapter (`@arki/dot/env`) is a plugin: `configure` stays synchronous and validates nothing, so `dot explain` needs no secrets. The factory validates at boot.
9. Never put benchmark numbers in prose. The `bench` block in the README is generated.

## Changing this package

- Edit `src/core/define-env.ts` for validation behaviour and `src/core/secret.ts` for secrets.
- Edit `src/presets/*` to add a variable shape. Export it from `src/presets/index.ts`.
- Edit `src/dot.ts` for the plugin. Keep `ENV_PLUGIN_ERROR_CODES` JSDoc with `@fix` and `@verify`.
- A change to validation defaults is breaking. Write a minor changeset and an upgrade guide in `docs/upgrades/`.
- Keep `README.md`, `llms.txt` and `docs/agent-guide.md` in step. Run `bun ../../tooling/library/src/llms.ts --write` after an export change.

## Verify

```sh
bun run test
bun run typecheck
bun run test:docs
bun run test:runtimes
bun ../../tooling/library/src/llms.ts --check
```
