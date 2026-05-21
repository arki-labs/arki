# DOT App Fixture

This fixture is the external proof that the DOT framework's end-to-end
behavior works outside the monorepo:

- booting an app with three adapters (`env`, `kv`, `db`);
- exposing `app.services` with typed entries for each adapter;
- exposing `app.manifest` as a `DotAppManifest` with all five contract
  arrays present (`plugins`, `routes`, `services`, `lifecycle`,
  `dependencies`);
- exposing `app.diagnostics` as a `DotDiagnosticsSnapshot` with one
  entry per plugin.

**Status: ACTIVE.** Tasks 9 (kernel) and 10 (adapters) have landed.
Task 11.5 (`dot new` scaffold) is the remaining piece — it will append a
generated-app test alongside the boot test below.

## How the fixture runs

The `bun release:arki fixture` matrix:

1. Packs `@arki/dot`, `@arki/env`, `@arki/kv`, and `@arki/db` from the
   monorepo into npm tarballs.
2. Creates a clean temp directory copy of this fixture (no monorepo
   workspace symlinks).
3. Installs the tarballs with each supported package manager (`npm`,
   `pnpm`, `bun`).
4. Runs `typecheck` (`tsc --noEmit`), `test` (`vitest run`), and `boot`
   (`node --experimental-strip-types src/app.ts`) inside the temp dir.

## Files

| File                 | Purpose                                                                          |
| -------------------- | -------------------------------------------------------------------------------- |
| `package.json`       | Declares the four `@arki/*` deps + `drizzle-orm` + `zod`.                        |
| `tsconfig.json`      | Strict, NodeNext resolution — what a real downstream consumer would use.         |
| `src/app.ts`         | Boots a real `defineApp(...)` with env + kv + db adapters; logs manifest + diag. |
| `tests/boot.test.ts` | Asserts the contract: typed services, five-array manifest, populated diags.      |

## Driver choices for hermeticity

The fixture must run on a developer laptop with no Postgres, no Redis,
no AWS, and no external services available. Driver choices:

- **env** — `skipValidation: true` so the fixture never depends on host
  env vars. The schema's defaults are exercised instead.
- **kv** — real `redis://127.0.0.1:1` URL (well-formed but
  unreachable). The KV constructor never blocks on connect — Keyv and
  ioredis open lazily. The fixture never calls `kv.get/set`, so the
  failed connection never surfaces. `kv.close()` tolerates the
  never-opened state during `dispose`.
- **db** — `driver: 'pglite', memory: true`. Embedded in-process Postgres
  via PGlite. No external server, no on-disk side effects.

## Forward dependencies

The only remaining forward dependency is **Task 11.5 — DOT New App
Scaffold**: when `dot new <name>` lands, this README will document a
sibling test that:

1. runs `dot new fixture-app --dry-run --json` from inside the fixture's
   temp dir and asserts the file-operation preview is exact and writes
   nothing;
2. runs `dot new fixture-app` for real, then runs `npm install` +
   `typecheck` + `test` + `boot` against the generated app in another
   temp dir and asserts it ships an `AGENTS.md`.

Until Task 11.5 lands, `tooling/arki-release/src/fixture.ts`'s
`buildDotFixtureForwardStubRuns()` helper records a single `skipped`
run per package manager flagged with `FIX_E008` so reviewers see what
remains.
