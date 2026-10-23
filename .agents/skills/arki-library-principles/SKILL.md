---
name: arki-library-principles
user-invocable: false
description: The standing rules every `@arki/*` library follows, in one checklist with the source of each rule. Types written once and inferred everywhere, schemas own validation, failures are returned not thrown, one dedicated integration per backend (Drizzle-style, no shared layer), general-purpose public API, no backward compatibility below 1.0, proof on Node, Bun, Deno, browser and Hermes, honest benchmarks against competitors, DEBUG lifecycle logs, OpenTelemetry by default, agent-first docs, tests on real objects. Load it before creating a package under `packages/` (`turbo gen package`), adding an export entry or backend adapter, designing or changing a public API, writing a changeset, or reviewing a diff under `packages/*`. Also when the user says "new arki lib", "new @arki package", "arki principles", "arki rules", or "does this follow arki".
---

# Arki library principles

One page that every `@arki/*` library follows. Each rule names where it was decided, so you can read the long form and so a later change updates the right file.

The eleven core principles have their long text in [`docs/arki/principles.md`](../../../docs/arki/principles.md) and their acceptance in the [decision ledger](../../../docs/arki/decisions.md) (A-33 to A-42). The founder rules below that carry a date instead of an A-number were said in conversation and are recorded only here. Dot has six principles of its own in [`packages/dot/docs/principles.md`](../../../packages/dot/docs/principles.md).

## How to use this skill

- **New package:** confirm it may exist (§ 1), then run the new-package steps at the end.
- **Any change under `packages/*`:** read the section for the kind of change, then run the before-commit checklist.
- **Subagent briefs for `@arki` work:** paste the four ABSOLUTE rules (§ 2, § 3, § 4 and the "never game a benchmark" line in § 9) verbatim. Subagents do not see this file unless you tell them to read it.
- **A rule is missing or wrong:** see "Adding or changing a principle" at the end. Do not edit a rule here without its source.

## 1. A package exists only when it must

- **New `@arki/*` packages are frozen** for six months from 2026-10-14 (A-06). A new package needs an explicit founder exception, recorded in the ledger (A-21 `failure`, A-32 `cli`). Ask before scaffolding.
- **Adapters are entries, not packages.** Platform code goes behind a subpath of an existing package: `./node`, `./browser`, `./react`, `./native`, `./dot`, `./drizzle`, `./orpc`, `./zod`, `./tanstack`, `./tanstack-start`, `./sentry`, `./mastra`, `./http`, `./testing`, `./vite`, `./pg`, `./server`. The list lives in `tooling/library/src/adapters.ts`. A feature that needs a new home is an entry first (A-16 notifications), a package last.
- **Folder = name.** `packages/<name>` holds exactly `@arki/<name>`. No group folders. Scope follows the folder: `packages/` is `@arki`, `fleet/` is `@fleet` (always private).
- **Arki is general.** Code that names this fleet (an app, a `fork.works` domain, our mail domains) or whose name is a product subject goes to `fleet/`. Unclear means fleet. Arki never imports fleet (`arki-layers` rule L005).
- **Layers:** foundation → kernel → platform → web → features. A package imports its own layer or lower. The tag sits in the package `turbo.json`; `arki-layers` enforces it in `turbo run lint` (L001 undeclared, L002 layer, L003 portable entry reaching a peer, L004 dev edge).
- **Names and trade-off designs are the founder's call.** Ask before naming a package, an entry or a public function. The founder dislikes generator-style APIs.

## 2. Every type is written once (ABSOLUTE)

The heart of Arki. The founder said it should never be broken (2026-10-14, reaffirmed 2026-10-19). Long form: "Define once, infer everywhere" and "Give identities and domain values distinct types" in `principles.md` (A-33, A-34, A-38).

- A type is declared at its source (a schema, a table, a builder chain, a definition) and inferred everywhere else. No restated type, no interface that mirrors an implementation, no hand-written union of names, no list in two places. One `as const` array feeds both.
- When a TS type and a runtime schema must both exist, the TS type is the source and an exact two-way type test locks the schema to it: `expectTypeOf<z.output<typeof schema>>().toEqualTypeOf<T>()`. A one-way `z.ZodType<T>` annotation is not enough; it missed real drift once (T12 step 10b).
- `unknown` only at a real untyped edge (operator JSON, webhooks), checked at runtime by the source schema. Never as a shortcut.
- Callers write no type arguments. TypeScript has no partial type-argument inference, so one spelled argument forces all of them. When a type cannot be inferred, take it from a value (an id declaration's `schema`), never from a type parameter.
- **Drizzle keeps all its type power** (2026-10-23). No wrapper over Drizzle's query or table API, no hand-written row types. Prove a generated table is type-identical to the hand-written one with a strict `toEqualTypeOf`.
- Every ID kind is a distinct, non-interchangeable domain type, even when two kinds share a format (A-38). Prefer brands for domain strings (email, URL, slug, tenant key). Define the brand once; parse external values through its canonical parser; never manufacture a brand with a cast.
- **A public brand is a TS type that its schema makes** (A-43, 2026-10-23). Declare `declare const xBrand: unique symbol; type X = string & { readonly [xBrand]: true }`. Make it with `z.custom<X>(value => is(value, base))` in the `./zod` entry, where `base` is the real check. Lock the two with an exact two-way type test. Never use a Zod `.brand()` for a type a public signature names: it puts `$ZodBranded` in the `.d.ts` (`TYPES_E001`). Example: `EventLogPosition` and `eventLogPositionSchema` in `@arki/journal`.
- A public `.d.ts` exposes no Zod types (`TYPES_E001`). An entry that accepts a caller schema takes a Standard Schema (`@arki/schema`); a package that builds Zod schemas exposes them under `./zod` with Zod as an optional peer. `@arki/contracts` and `./zod` entries are exempt.

## 3. Schemas own validation (ABSOLUTE, A-39)

Founder, verbatim: "everything that needs some validation needs to come from a schema. zod and libs like that are the boss over this. Fully."

- Every check that turns an unknown value into a typed one comes from a Standard Schema. Zod is the default; Valibot and ArkType also count. Arki adds no validation vocabulary of its own (the `@arki/assert` design was rejected as "a second Zod").
- Expected bad input: `parse(schema, value)` from `@arki/schema` returns `InvalidInput`.
- A bug: `assert(value, schema)` narrows in place, `ensure(value, schema)` returns the schema output, `is(value, schema)` tests. They throw.
- Structural checks are schemas too: `is(value, recordSchema)`, never `typeof x === 'object' && x !== null`. No hand-written `isX(value: unknown)` guards.
- Out of scope: preconditions on already-typed values in a hot path use `invariant` from `@arki/failure`; exhaustiveness uses `unreachable`.
- Approved exceptions keep plain checks and never copy a schema locally: `@arki/failure` (schema depends on it), `@arki/log` (zero dependencies), `@arki/bench` (dev tooling). A zero-dependency package that cannot take Zod writes a hand-written Standard Schema.
- Secrets are declared in the schema with `secret()`. Nothing else keeps a list.

## 4. Failures are returned, never thrown (A-33)

Long form: "Own failures and execution" in `principles.md`; the outcome table in the ledger under "Error ownership".

- Every fallible public operation returns `Value | Failure<...>` from `@arki/failure`. No `ok()` wrapper, no `.value` step. The failure union is inferred from the code, never annotated by hand.
- One `defineFailure` per kind, with a dotted code `<package>.<snake_case>` (A-24). Match on `code`, never on the message.
- Expected outcomes of the package itself are returned failures (A-24, A-30): a held lock, a declined card, a quota, a conflict. Bugs, misuse and configuration faults throw (`FailureError`, `invariant`, `unreachable`).
- A returned failure is final: resilience and queue do not retry it unless `backoff(...).while(...)` accepts it, and it does not count toward a circuit breaker (A-23). A throw is retried by the default policy.
- A discarded failure is a lint error (`failure/must-use`); `accept` only after a `Def.is` check (`failure/no-blind-accept`).
- A pure total operation has failure type `never`. Do not add artificial failure dependencies.
- Every error code in `src/errors.ts` has a JSDoc summary, `@fix` and `@verify` (`ERR_E001`).

## 5. One dedicated integration per backend (2026-10-23)

Founder, during journal store-modes slice 8: "less abstractions, more things like drizzle: dedicated integrations for each that you import and use directly." Recorded as A-42.

- Each backend (a store, a log, a pub/sub, a driver, a provider) is its own subpath module that the app imports directly: `@arki/journal/postgres`, `@arki/pubsub/pg`, `@arki/pubsub/sqlite`, like `drizzle-orm/node-postgres`. It owns its code and its queries.
- No shared runtime layer that several backends run through, no union-typed helper that picks its SQL at runtime, no generic backend with a dialect switch. Some query text repeating between adapters is fine.
- Sharing plain declarations is still fine: a column list, a Zod schema, a contract test suite (`eventLogContract`, `pubSubContract`). The rule is against runtime layers, not shared facts.
- Queries stay plain Drizzle, one file per dialect (§ 2). This is the backend-adapter side of "propose a shared primitive before boilerplate": that rule is for app code, not for backends.
- Platform dependencies of an adapter entry are optional peers. A portable entry (`.`) reaches a peer only through a lazy `import()` (L003).

## 6. Portable by proof, browser-safe by contract

Long form: "Prove portability" in `principles.md` (A-35, A-41). Founder, 2026-10-13: "make sure Bun, Deno, Node, browser and other envs are supported in all."

- The root entry is pure ESM on web-standard globals: no `node:*`, `bun`, `bun:*`, `process`, `Buffer`, `require`, `__dirname`. The `@arki/eslint-config/library` preset forbids them; a package lints with one line: `export { default } from '@arki/eslint-config/library';` (or `library({ adapters: ['src/node/**'] })` for adapter folders).
- Every package proves its runtimes: `"test:runtimes": "arki-runtimes"` plus `scripts/smoke.mjs` printing `N smoke checks passed`. Legs: purity (each entry in a fresh empty-env process), Node, Bun, Deno (`--no-config`, bundled `--target=node` when it has npm deps), browser (Playwright Chromium), Hermes (`HERMES_BIN`). A missing engine is INCOMPLETE, fatal only with `--require-all`. Deno leg details: `--no-config --node-modules-dir=manual`.
- Hermes V1 lacks `Array#toSorted/toReversed/toSpliced`, `structuredClone`, most `Intl` constructors and `formatToParts`. Never build an `Intl` object at module load. Probe at runtime and throw `UnsupportedFeatureError` rather than degrade. Never capture a loop variable in a closure (Hermes scopes `let` in a loop to the function); call a named function per iteration.
- The five-runtime and benchmark rules apply to leaf libraries, not app-layer packages such as queue, payments, auth and mail (A-05).
- A library whose root is server-side, and that exports what an oRPC contract needs (failures, ids, input and output schemas), offers them through one browser-safe `./contract` entry (A-41). The name is singular; `./contracts` is forbidden (`CONTRACT_E002`). `arki-library-check` bundles every `./contract` for the browser and fails on server code (`CONTRACT_E001`). A `./errors` entry carries no browser promise.
- Never add a `"./*"` catch-all export. Every entry is explicit with a `types` condition (`arki-library-check`). Check the exports map before importing a new subpath from an app.
- Runtime support is stated in the README `Runtime support` section (`DOC_E017`).

## 7. Observable by default, quiet by default

Long form: "Everything can be observed with OpenTelemetry" in `principles.md` (A-36).

- Instrument meaningful boundaries (requests, usecases, provider and database calls, jobs, workflow attempts, AI calls, streams, retries, cleanup) with traces, metrics and correlated logs. Reuse existing instrumentation for the same boundary; no duplicate spans (oRPC already spans a procedure).
- Libraries never install or configure a global SDK. Without configured telemetry the surface is safe to call and does no export I/O. Telemetry cannot change a result or hide a failure.
- Stable names, bounded metric dimensions, safe attributes. Secrets, prompts, model output and user payloads are not collected by default.
- Each package records which boundaries it instruments and why the others need none.
- Logging goes through `getLogger('arki:<name>')` from `@arki/log`, never `console.log`. Libraries never call `configure()`. Lifecycle messages (`starting`, `done`) are DEBUG, opted in with `DEBUG=arki:<name>`; INFO is for events a consumer cares about at scale; WARN for degraded success; ERROR for the failing operation (founder, 2026-05-21). Lifecycle lines at INFO broke a CLI subprocess test once.

## 8. Tests run on real objects

Long form: "Make behavior reproducible" in `principles.md`; founder correction of the arki.dev copy on 2026-10-22.

- A test starts the real thing: a real Postgres from `@arki/testing` (testcontainers), the real repository, the same app you ship. Fakes only for what cannot be real (time, randomness, paid models), and every fake has a contract test against the real implementation. A passing fake test proves nothing about the integration.
- Tests encode why the behaviour matters. A test that cannot fail when the business rule changes is wrong.
- Every public type has a type test (`expectTypeOf`, `*.test-d.ts`). Lost inference, a widened failure union and schema drift must fail a test.
- After writing a guard or a branch, do a mutation check: edit the condition, see the test fail, edit it back. Never back up and restore whole files in the shared tree.
- A package with a `./dot` entry shows `dot explain --json` and `dot doctor --json` under `Verify` in its agent guide (`DOC_E011`).

## 9. Benchmarks against competitors, never gamed

Founder, 2026-10-13: "All the arki libs should have benchmarks, and a section in documentation about the benchmarks run against the most popular competitors." And: "never game the benchmark. Ever, never."

- A public lib is not release-ready without `bench/<name>.bench.ts` on `@arki/bench` (`defineSuite`, `compare`, `scenario`, `size`, `metric`), script `"bench": "bun run build && arki-bench"`, and a README section between `<!-- bench:start -->` and `<!-- bench:end -->`. Model suite: `packages/money/bench/money.bench.ts`.
- Speed for runtime code; bundle size for UI, CSS, tokens and icons; type-check instantiations for `@arki/ts`.
- Compare groups rank only rows that keep one written contract, checked on varied inputs before timing. A rival with another promise is `differs`; a same-library alternative is `variant`; no rival means `scenario`. Never remove or hide a losing row.
- Microseconds matter only on hot paths (string, math, date, log, http routing, money). Never rewrite or drop a battle-tested dependency to win a microsecond in a wrapper around a slow call.
- **Never game a benchmark.** No fast path keyed to the benchmark's input shape, no memoizing by input to win repeated calls, no deferring measured work out of the timed call, no weakened validation, no edited contract or inputs to dodge a loss. Report a loss with its real cause and honest options. Put this line verbatim in every perf agent brief.
- The README section is written only by `bun run bench --profile publish --write-readme`, one package at a time, on an idle machine. Agents check suites with `--profile quick` only and never time benchmarks in parallel. Re-render a saved run with `arki-bench report` instead of re-measuring.
- Never `eslint --fix` a suite blindly; an autofix once rewrote rival `toFixed()` calls and changed the results.

## 10. Public API: general purpose, explicit, honest about scope

- `@arki/*` packages are for anyone, not only this monorepo (2026-10-12). Never remove, narrow or skip an export because "no app uses it". Judge an export by whether it is a coherent, documented, type-tested part of the contract. An unused exported type gets a JSDoc example and a type test, not deletion.
- App-specific conveniences stay out. Ship the general primitive and let apps compose.
- Code is written by an agent and read by one (2026-10-22). Choose the explicit form over the compact one. Prefer a type, a lint rule or a test over a convention someone must remember. No helper whose only job is to make code shorter. No magic.
- Names are short, never vague: a reader who sees only the definition line can say what it is for.
- Features that need a framework (Zod, React, Drizzle, oRPC) live in optional subpaths with peer dependencies (§ 1, § 5).
- Start small; grow through composition. The package is usable alone; Dot composes it. Applications own infrastructure and provider choices.
- Shared execution does not mean shared authority. Each boundary (HTTP, job, CLI, AI tool) establishes principal, tenant, permissions and approvals itself. A model choosing a tool grants nothing.
- Durable work keeps business truth across interruptions: distinct accepted, running, completed, failed, cancelled and uncertain outcomes; stable identities; versioned persisted contracts; documented delivery guarantees; idempotency where effects may repeat. Uncertain external writes are reconciled before replay.
- Resource costs are explicit and bounded: time, attempts, concurrency, tool calls and model spend have limits; child work respects the parent's remaining budget. Framework overhead (bundle, startup, memory, type-check time) has measured budgets.

## 11. Versions: 0.x, breaking is a minor, no shims

Founder, 2026-10-12: "no BC till v 1.0." Reconciled guidance in the ledger (2026-10-19).

- Every package stays on the 0.x track until the founder reserves 1.0. A package versioned ≥ 1.0 that was never published is renumbered to 0.x (also its `version` line in `bun.lock`).
- A breaking change is a **minor** changeset, never `major`. Any other change is a patch. Check every changeset a subagent writes.
- No `@deprecated` aliases, no compatibility re-exports, no legacy shims. Change the name or signature outright, delete the old one, update every call site in the monorepo in the same change. Name the rename in the CHANGELOG; explain the break in `docs/upgrades/<from>-to-<to>.md`.
- Every release updates docs and demos, or the changeset says `no docs impact: <reason>` and/or `no demo impact: <reason>` (A-27).
- Agents never run `npm publish`, never push (A-26). Release is the `arki-release` skill; publishing is founder-only with OTP.

## 12. Docs are agent-first and checked

`arki-library-check` runs the `DOC_*` rules on every public package; `arki-doc-examples` compiles and runs the code blocks (`test:docs`). The rule table is in `tooling/library/README.md`.

- Four files: `README.md` (long overview for humans; H2s in order `Install`, `Quick start`, `When not to use this`, `Runtime support`, then `Public imports`, `Failure behaviour`, `Limits`), `llms.txt` (the map an agent reads first, under 80 lines and 8 KiB, sections `Import paths`, `Start here`, `By task`, `Rules that bite`, optional `Optional`), `docs/agent-guide.md` (the model, the task map, the rules that bite, the errors, how to verify), and `AGENTS.md` (line 1 `AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.`, then H2s `Laws`, `Changing this package`, `Verify`). Plus `CHANGELOG.md` and the MIT `LICENSE`.
- Every `ts` block compiles against the built package; `run` blocks run on Bun. Examples use inferred types (`DOCX_E006`) and import the package by name (`DOCX_E007`).
- Links stay inside the package or go to `https:` (`DOC_E009`). The tarball has nothing outside.
- Banned words in README, docs and `llms.txt`: simply, just, easy, powerful, blazing, seamless, robust, leverage, might, should probably (`DOC_E019`).
- `llms.txt` "Import paths" is generated from `exports` (`arki-llms`), so it cannot drift.
- Docs for a program explain every decision with its reasoning, in many small files with diagrams, in plain words. Comments say why, short. Humour never obscures meaning.
- The package `version` is never a string literal in `src/**` (`SRC_E001`).

## 13. Tooling comes from the workspace, never per package

- Shared configs only: `@arki/eslint-config/library`, `@arki/prettier-config`, `@arki/tsconfig`, `@arki/vitest-config`. Do not create a per-package eslint, prettier, tailwind, tsconfig base, vitest or playwright config.
- Dependencies: `bun add` inside the package directory, versions from the root catalog (`catalog:`). Never at the workspace root, never `bunx`.
- Gates in `turbo run lint`: `arki-layers` and `arki-library-check --all`. Baselines in `tooling/library/*-baseline.json` shrink only; a stale entry fails. Never grow a baseline to pass.
- `turbo boundaries` is advisory only: it counts optional peers as undeclared and cannot see entries.
- Use `turbo <task> --filter=@arki/<name>` for build, test, typecheck, lint.

## New package steps

1. Founder approval for the package (A-06) and for its name (§ 1). Confirm it is not an entry of an existing package.
2. `turbo gen package` → `packages/`, name, layer. The generator writes `turbo.json`, `package.json`, `tsconfig.json`, `eslint.config.js`, `src/index.ts`, `README.md`, `llms.txt`, `docs/agent-guide.md` and `AGENTS.md`. Keep `private: true` until the release skill promotes it.
3. Write the package laws in `AGENTS.md` under `Laws`: one sentence each, specific to this package, after the line that names this skill.
4. Design the public API: source types once (§ 2), Standard Schema on the accept side and `./zod` on the produce side (§ 3), returned failures with dotted codes (§ 4), one subpath per backend (§ 5), explicit entries with `types` (§ 6).
5. Add `"test:runtimes": "arki-runtimes"`, `scripts/smoke.mjs`, and `"test:docs": "arki-doc-examples"` with the `@arki/library-tooling` dev dependency.
6. Tests on real objects plus type tests for every public type (§ 8). Logging at DEBUG through `@arki/log` (§ 7). Record instrumented boundaries.
7. `bench/<name>.bench.ts` against the most popular competitors (§ 9).
8. Run `turbo run lint typecheck test test:docs test:runtimes --filter=@arki/<name>`; the layers and library-check gates run inside `lint`.
9. Changeset: `minor` for the first public shape. Then the `arki-release` skill's `add-new-package.md` for promotion, which re-checks this list.

## Before-commit checklist for any `packages/*` diff

- No type written twice; no type arguments at call sites; no Drizzle wrapper (§ 2).
- No hand-written guard on an unknown value (§ 3).
- No thrown expected outcome; no `ok()` wrapper; no discarded failure (§ 4).
- No shared runtime layer over backends (§ 5).
- No `node:*`, `process`, `Buffer` in a portable entry; no `./*` export; `./contract` where an oRPC contract needs it (§ 6).
- No `console.log`; lifecycle at DEBUG; no global OTel SDK (§ 7).
- Real objects in tests; a type test for every new public type; mutation check done (§ 8).
- Benchmark still honest; suite checked with `--profile quick` (§ 9).
- No export removed because "nothing uses it" (§ 10).
- Changeset present, `minor` for a break, no shim, every caller updated (§ 11).
- Docs updated; `test:docs` green; no banned word (§ 12).
- Commit with `git -c commit.gpgsign=false commit`, by pathspec, only your own files. Never push.

## Where each rule lives

| Rule                                                                                                                                                         | Source of truth                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Eleven core principles (types once, identities, schemas, failures, portability, OTel, composition, authority, explain, interruptions, reproducible, budgets) | `docs/arki/principles.md`, ledger A-33 to A-39                                                                                               |
| Dedicated integrations per backend                                                                                                                           | `docs/arki/principles.md` § "One dedicated integration per backend", ledger A-42                                                             |
| `./contract` entry                                                                                                                                           | ledger A-41, `arki-library-check` CONTRACT rules                                                                                             |
| Package freeze, admissions, tiers                                                                                                                            | ledger A-06, A-28 to A-32, A-40; `docs/arki/core-packages.md`                                                                                |
| Structure, layers, adapter entries, fleet split                                                                                                              | `docs/rfcs/2026-10-14-arki-structure.md`, `docs/rfcs/2026-10-17-fleet-packages.md`, `tooling/library/src/{layers,adapters,library-check}.ts` |
| Standard Schema accept side, `./zod` produce side, `TYPES_E001`                                                                                              | `.work/plans/2026-10-16-standard-schema/synthesis.md`, `tooling/library/README.md`                                                           |
| Failure depth and retry policy                                                                                                                               | ledger A-21 to A-24, A-30, A-33; `packages/failure/AGENTS.md`                                                                                |
| Five runtimes, Hermes caveats                                                                                                                                | this file § 6; `tooling/library/src/runtimes.ts`; `@arki/eslint-config/library`                                                              |
| Benchmarks and never gaming them                                                                                                                             | this file § 9; `packages/bench/README.md`; `.agents/skills/arki-release/add-new-package.md`                                                  |
| General-purpose API, no BC below 1.0, DEBUG logs, real-object tests, explicit code                                                                           | this file § 7, § 8, § 10, § 11 (founder statements with dates)                                                                               |
| Docs rules                                                                                                                                                   | `tooling/library/README.md` (DOC, DOCX, SRC, TYPES tables)                                                                                   |
| Versioning and changesets                                                                                                                                    | ledger "Reconciled guidance (2026-10-19)", A-27                                                                                              |
| Release                                                                                                                                                      | `.agents/skills/arki-release/SKILL.md`                                                                                                       |

## Adding or changing a principle

1. The founder states or approves it. A principle is never added from an agent's own taste.
2. Record the decision: a row in `docs/arki/decisions.md` with date and the founder's words. If it is a design requirement for every package, add a section to `docs/arki/principles.md` with its verification criteria.
3. Add the rule to the matching section of this file, with its source, in plain English, one idea per sentence.
4. If a tool can enforce it, add the rule to `arki-library-check`, `arki-layers` or the eslint preset with a code and a shrink-only baseline. A rule in a tool beats a rule in a file.
5. Tell the person reading this file where the rule lives (the table above).
