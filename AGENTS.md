# AGENTS.md

Rules for coding agents working in `arki-labs/arki`. This file loads into every
session. Linked files load only when the task needs them.

## What this repo is

The source of every `@arki/*` npm package, plus the tooling that checks and
releases them.

```text
packages/<name>/   one npm package each (@arki/<name>)
tooling/           shared configs (@arki/tsconfig, eslint, vitest, prettier),
                   library checks (@arki/library-tooling), release tool
docs/releases/     the release ledger (RELEASES.md)
docs/arki/         principles, decisions, glossary
docs/rfcs/         design proposals
.agents/skills/    agent skills (also linked at .claude/skills)
.changeset/        pending version bumps
```

The arki.dev site is not in this repo. It lives in the private workspace
repo (`apps/arki`). `bun release:arki site --out <its start dir>` writes the
package docs, the data files and a zod-only copy of their schemas into it.

## Before you write code

- **New package, public API, adapter entry, changeset, or review of a
  `packages/*` diff:** load the `arki-library-principles` skill first. It holds
  every standing rule with its source.
- **Releasing:** load the `arki-release` skill.
- Read the package's own `AGENTS.md` and `docs/agent-guide.md` when present.

## Hard rules

1. **Every type is written once.** Declare it at its source (a schema, a table,
   a builder chain) and infer it everywhere else. No restated types, no
   interface that mirrors an implementation, no list kept in two places. When a
   TS type and a runtime schema must both exist, lock them with a two-way type
   test: `expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<T>()`.
2. **Schemas own validation.** Every check that turns an unknown value into a
   typed one comes from a Standard Schema. Expected bad input: `parse`. A bug:
   `assert` / `ensure` / `is` from `@arki/schema`. Preconditions on typed
   values: `invariant` from `@arki/failure`.
3. **Failures are values.** Expected errors are returned with a stable code.
4. **Type safety.** No `any`, no `@ts-ignore`, no unsafe casts.
5. **Logging.** Never `console.log`. Use `getLogger('arki:<name>')` from
   `@arki/log`. Lifecycle logs go at `debug`. Libraries never call
   `configure()`.
6. **One dedicated integration per backend**, imported directly (like Drizzle's
   drivers). No shared layer over adapters.
7. **Arki is general.** Code that names a specific product or app does not
   belong here.
8. **Tests use real objects.** Real Postgres, real Redis, the real public API.
   Fake only time, randomness and paid services. A test must be able to fail
   when the behaviour it guards changes.
9. **No stubs or TODOs.** Ship working code or nothing.
10. **Versioning below 1.0:** a breaking change is a `minor` changeset and
    updates every caller in the repo in the same change, with no shim.

## Commands

```sh
bun install
bun run build
bun run turbo run typecheck lint test --filter=@arki/<name>
bun run library-check     # arki library rules (exports, docs, examples)
bun run layers            # dependency layer rules
bun run changeset         # record a version bump
```

Install a dependency inside the package folder (`bun add <dep>`), never at the
root. Shared versions live in the root `catalog` / `catalogs`.

## Git

- `main` is the only branch maintainers push. Contributors open pull requests.
- Commit with `git -c commit.gpgsign=false commit` in automated contexts.
- Never force-push `main`.
- Agents never run `npm publish`. The release tool prints the publish
  commands for a maintainer.
