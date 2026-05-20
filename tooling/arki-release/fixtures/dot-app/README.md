# DOT App Fixture — Forward-Dependency Stub

This fixture is the external proof that the DOT framework's end-to-end
behavior works outside the monorepo:

- booting an app with at least three adapters;
- exposing `app.manifest` as `DotAppManifest`;
- exposing `app.diagnostics` as `DotDiagnosticsSnapshot`;
- matching the `dot explain --json` / `dot doctor --json` contracts; and
- generating new apps via `dot new <app>` without writing into the monorepo.

**Status: SKELETON — pending Tasks 9, 10, and 11.5.**

Today every file in this directory ends in `.template`. Nothing here is
imported by the live fixture matrix. The matrix's
`buildDotFixtureForwardStubRuns()` helper produces explicit `skipped`
runs tagged with the `FIX_E008` info code so reviewers can see what is
PLANNED — never accidentally green.

## Forward dependencies

- **Task 9 — DOT Kernel.** Fills in `src/app.ts.template` with
  `defineApp(...)`. Once `@arki/dot` exports `defineApp`, this file
  becomes a real `app.ts` and the fixture starts asserting against
  `app.manifest` / `app.diagnostics`.
- **Task 10 — Adapter Waves.** Wires three of the package-owned adapters
  (e.g. `@arki/env/dot`, `@arki/kv/dot`, `@arki/db/dot`). The fixture's
  `dependencies` block in `package.json.template` switches from
  `FORWARD_TASK_*` placeholders to real semver ranges. The
  `tests/boot.test.ts.template` asserts that all five diagnostic arrays
  surface even when no failures exist.
- **Task 11.5 — DOT New App Scaffold.** Adds the test that runs
  `dot new fixture-app --dry-run --json` (verifying the file-operation
  preview is exact and writes nothing), followed by `dot new fixture-app`
  (asserting the generated app installs, typechecks, tests, boots, and
  ships an `AGENTS.md` outside the monorepo).

Until Tasks 9 + 10 + 11.5 land, none of the assertions above can run.
The fixture matrix records the deferred work as `skipped` runs — see
`tooling/arki-release/src/fixture.ts`,
`buildDotFixtureForwardStubRuns()`.

## Files

| File                            | Status                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `package.json.template`         | Carries `FORWARD_TASK_9` / `FORWARD_TASK_10` strings so an accidental install fails loudly until the placeholders flip.   |
| `tsconfig.json`                 | Strict, `NodeNext` resolution — ready to consume the published DOT packages once they exist.                              |
| `src/app.ts.template`           | Comment-only stub describing the eventual `defineApp(...)` boot.                                                          |
| `tests/boot.test.ts.template`   | Comment-only stub describing the eventual assertions on `app.manifest`, `app.diagnostics`, and `dot explain` / `doctor`.  |

## How to "wake" the fixture

When Task 9 lands:

1. Rename `package.json.template` → `package.json`, replace the
   `FORWARD_TASK_*` strings with real semver.
2. Rename `src/app.ts.template` → `src/app.ts`, implement the boot.
3. Rename `tests/boot.test.ts.template` → `tests/boot.test.ts`,
   implement the assertions.
4. Add `@arki/dot` (and the three adapters) to the public tree
   allowlist in `arki.release.config.ts`.
5. Delete the `buildDotFixtureForwardStubRuns` call in
   `tooling/arki-release/src/cli.ts` — the matrix will now exercise the
   fixture for real because the packages exist in the public tree.

## Why a skeleton?

The fixture exists today (rather than being added later) so:

- the directory layout is reviewable now;
- the forward dependency is documented in code, not in a side doc;
- the `buildDotFixtureForwardStubRuns()` helper can produce explicit
  `skipped` envelope entries that fail-loud if anyone tries to mark the
  DOT contract green ahead of the underlying work.
