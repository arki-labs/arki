# RFC: the shape of `@arki/*`

- Date: 2026-10-14
- Status: Accepted 2026-10-14. Founder decisions: D1 add tokens, D2 keep and relocate, D3 merge as entries.
- Designers: Fable and Astra, independently; merged here. Sources: `scratchpad/arki-structure-{fable,astra}.md` (session scratch, not kept).
- Scope: backlog B1–B18 (`plans/packages/README.md`), a shared library tooling preset, and a new `@arki/async`.

## 1. The shape in one sentence

**One flat folder per product, a portable core with named adapters, six layers that point down, and checks that are run by tools, not remembered by people.**

## 2. Principles and the tool that enforces each

| # | Rule | Enforced by |
|---|---|---|
| P1 | **Folder = name.** `packages/<name>/` holds exactly `@arki/<name>`. No group folders. The monorepo tree equals the public mirror tree. | `arki-library-check`; root `workspaces` is `packages/*` + `tooling/*` + app globs only. |
| P2 | **Six layers, arrows point down.** A package imports its own layer or lower (§4). | Boundaries tags in each `turbo.json` hold the layers; `arki-layers` (tooling/library) enforces them per export entry in `lint`. Decided 2026-10-14: `turbo boundaries` counts optional peers as undeclared and cannot see entries, so it stays an advisory report (`bun run boundaries`). |
| P3 | **Portable core, named adapters.** `.` and plain subpaths run on Node, Bun, Deno, browsers and Hermes. Platform code sits behind an entry named for what it adapts to: `/node`, `/browser`, `/react`, `/native`, `/dot`, `/drizzle`, `/tanstack-start`, `/testing`. Adapter deps are optional peers. | `@arki/eslint-config/library` (portable rules on `src/**`, adapters exempt); `arki-runtimes`. |
| P4 | **Importing does nothing.** No env reads, IO, timers or registrations at import. | `arki-runtimes` purity leg (`expectImportPure` from `@arki/ts/testing` on every export entry). |
| P5 | **Explicit exports.** No `"./*"` wildcard. Every entry has `types` and points into `dist/`. | `arki-library-check`. |
| P6 | **A Dot plugin lives in the package it wraps (`/dot`), unless Dot already depends on that package** — then it lives in Dot (`@arki/dot/log`). | Boundaries: `foundation` denies `@arki/dot`. |
| P7 | **`packages/` holds products.** A package must be describable without naming an app. Usage count never decides (house rule). | Review rule. |
| P8 | **Coded errors, clean breaks before 1.0.** `ARKI_<PKG>_E00n` with remediation; a breaking change is a **minor** changeset; every call site is updated in the same slice; no shims. | Release scorecard; changeset check. |

## 3. Package map

77 manifests today. **No published name changes** (the 24 in `arki.release.config.ts:53-113`), so no npm deprecations.

### Moves only (flatten; name unchanged)

`books/import → books-import`, `games/solitaire → games-solitaire`, `games/solitaire-ui → games-solitaire-ui`, `games/sudoku → games-sudoku`, `react/fullscreen → react-fullscreen`, `react/hooks → react-hooks`, `react/sound → react-sounds`, `text/bible → text-bible`, `text/dictionary → dictionary`, `text/embeddings → text-embeddings`, `text/hyphen → text-hyphen`, `text/merriam-webster → mw-dictionary`, `text/poetry → poetry`, `ui/base → ui`, `ui/chat → chat-ui`, `ui/icons → icons`, `ui/native → native-ui`.

This also fixes the public mirror: `export-public.ts:288` names the folder after the source basename, so `@arki/ui` ships today as `packages/base` and `@arki/react-hooks` as `packages/hooks`.

### Into apps (P7)

- `f04-config` → `apps/evervest/config` (`@evervest/config`). It encodes Evervest decisions (`f04-config/src/config-keys.ts:9`).
- `design-systems-apps` → per-app `design` workspaces. Consumers today: `apps/readingpath/start`, `packages/sitekit`. Sitekit gets `registerDesignSystem()` and stops importing app brands (a package→app inversion).

### Family merges (D3: merge as entries)

Small, unpublished, single-job packages become entries of one product. Nothing is deleted; each lives on as an entry.

| Today | Becomes | Importers |
|---|---|---|
| `html-to-md`, `html-to-text`, `md-to-html` | `@arki/formats/{html-to-md,html-to-text,md-to-html}` — one unified/remark engine (B4) | 0 |
| `usfm-to-json` | `@arki/formats/node` (it needs a native tree-sitter addon, so it is a Node adapter) | 0 |
| `md-to-pdf` | stays its own product (React-PDF is a heavy, different dependency) | 0 |
| `domains-availability`, `domains-tlds`, `namecheap` | `@arki/domains` with `/availability`, `/tlds`, `/namecheap` | 5, 1, 0 |
| `text-operations` | the root of `@arki/text` (it was the package's only content: `text/src/index.ts:15` re-exported it whole) | 1 |
| `spinners` | `@arki/icons/spinners` | 0 |
| `diff-engine` | rename `@arki/diff` (private) | 5 |

Rejected alternative: keep every product as its own flat folder.

Result: 77 → about 68 folders. New: `async`, `seo`, `feedback`, `domains`. Gone as folders: 13.

### Splits

- **sitekit (B6)** keeps the shell: layout, components, nav/app context, projects, devtools, i18n, tweaks. Out go `seo/` → **`@arki/seo`** (244 import sites, with a `/tanstack-start` adapter), `feedback/` → **`@arki/feedback`** (takes the `emails` dependency with it), `auth/` → **`@arki/auth/react`** and `@arki/auth/tanstack-start` (P3: auth owns its UI adapters; no new package).
- **images (B5):** the comparison components move to an `@arki/images/react` entry with `react` and `@arki/ui` as optional peers. The core drops its upward `ui`/`sitekit` deps.
- **contracts (B1):** `.` = zod + ids, portable. **`/drizzle`** = `createSelectSchema`/`createInsertSchema`/`createUpdateSchema`; `drizzle-orm` becomes an optional peer. 24 files import `/schema` (rename), and about 94 call the wrappers through `.` (repoint).

## 4. Layers

```
 tooling     bench, testing                               (dev-only)
 features    sitekit, tanstack-start, waitlist, feedback, games-sudoku
 web         ui, icons, theme, design-systems, react-*, chat-ui, native-ui, code-editor,
             rich-text, content, intl, seo, payments-native, games-solitaire-ui
 platform    db, kv, http, journal, queue, schedule, fs, emails, auth, payments, ai, meter,
             geo, domains, scraping, images, formats, md-to-pdf, rss, admin, diff, text,
             text-bible, text-embeddings, text-hyphen, mw-dictionary, books-import,
             offline, dictionary
 kernel      dot, feature, env
 foundation  ts, math, string, date, clock, money, log, contracts, resilience, assert,
             async, games, games-solitaire, poetry
```

`web → platform` is allowed (`chat-ui → ai`). `platform → web` is not (B5's bug). `web` also denies server-only packages: `db`, `kv`, `queue`, `fs`, `emails`. A package's React entry (`/react`) is an adapter; tags are per package, and the lint preset guards the portable entries.

Every layer may also use `tooling` (eslint-config, tsconfig, bench, library-tooling).

First run (2026-10-14): the only layer violations are `images → ui, sitekit, design-systems(-apps), theme, icons, intl, react-hooks, code-editor, tanstack-start` (B5 fixes it). `offline` (imports db, kv, emails) and `dictionary` (imports kv, fs, env, dot) moved to platform after that run. The same command also reports about 2,700 undeclared-dependency findings (a package imports something its `package.json` doesn't list). Those must reach zero before W5 makes `turbo boundaries` blocking.

## 5. Backlog decisions

| | Decision |
|---|---|
| B1 | `contracts/drizzle` (§3). Minor changeset. |
| B2 | Obsolete — `event-sourcing` is gone. Close it. |
| B3 | Vitest for `tanstack-start` pure parts (router, server path handling, request-isolated query client); `seo.ts` moves to `@arki/seo` with its tests; purity leg on every entry. |
| B4 | One Markdown engine (unified/remark) in `formats`; `marked` leaves (`formats/src/markdown.ts:404`, `:467`). Golden fixtures: GFM, raw HTML, sanitizing, malformed input. `src/html.ts` uses `DOMParser`/`Element` with no DOM lib (typecheck fails today): it is a browser adapter, so it moves behind `@arki/formats/browser`. |
| B5 | `images/react` entry (§3). |
| B6 | sitekit split (§3). 39 apps update four import prefixes. |
| B7 | `content`: `.` (models, search, feeds — portable, time injected), `/node` (build pipeline: sharp, unified), `/react`. Tests for search ranking and feed ordering. |
| B8 | `button.tsx:10` `ring-blue-500/75` → `ring-ring`. D1: add `--success`, `--warning`, `--info` (+ `-surface`) to every design system's shared contract, the way `tribunal/tokens.css:64-82` already does; the callout uses them. |
| B9 | Delete deprecated `withCircuitBreaker` (`resilience/src/execute.ts:50-58`). Minor. |
| B10 | Close as fixed (`schedule/src/runtime.ts:178`, `:195`; test at `schedule.test.ts:263`). |
| B11 | `rss`: own contract. `.` = feed types + `parseFeed`, `/generate` = writer. Drop the vendor re-export and `./*`. |
| B12 | `geo` tests with fakes: provider normalizing, fallback order, cache keys/TTL, cancellation. |
| B13 | `testing`: explicit exports (`/postgres`, `/redis`, `/auth`, `/msw`, `/vitest`, …). The "6 `any`" are prose, not types. |
| B14 | `string` and `date` adopt the preset (`test:runtimes: arki-runtimes`). Keep Segmenter and Temporal fallback fixtures. |
| B15 | `assert` keeps `isUrl`/`isBase64`; `isLanguageCode` moves to `@arki/intl/language`, behavior pinned by fixtures first. |
| B16 | Move `f04-config` and `design-systems-apps` into apps. `books-import`, `diff`, `rich-text`, `text` stay products. Fix readiness defects found: empty `GoodreadsImporter` (`books/import/src/goodreads.importer.ts:1`), silent mock fallback in production (`text/operations/src/services/index.ts:19`). |
| B17 | Flat layout (§3). Exporter derives the folder from the npm name, checked against the folder. |
| B18 | `packages/text/dictionaries` — 478 MB, two git submodules, zero code reads. D2: keep both submodules pinned; relocate to `packages/dictionaries` as a private data reservation; record pins and licenses. |

## 6. The tooling preset

A library writes **one lint line and one script line**.

**Lint** — `tooling/eslint/library.js`, exported as `@arki/eslint-config/library`. It holds the block now copied in `packages/math/eslint.config.js`: no `node:*`/`bun` imports, no `process`/`Buffer`/`require`/`__dirname`, no `toSorted`/`toReversed`/`toSpliced` (Hermes), applied to `src/**`, skipping tests and `src/node/**`. A `library({ adapters })` factory covers packages with other adapter folders.

```js
// packages/math/eslint.config.js — before: 44 lines. After:
export { default } from '@arki/eslint-config/library';
```

**Runtime proof** — `tooling/library/` (`@arki/library-tooling`, private) ships two bins.

```json
"test:runtimes": "arki-runtimes"
```

The package keeps only `scripts/smoke.mjs`. `arki-runtimes` reads the manifest and runs:

0. **purity** — import every export entry in a fresh process with an empty env; fail on env reads, timers or IO.
1. **node**, 2. **bun** — run the smoke file on the built output.
3. **deno** — if the package has no npm dependencies, run unbundled with `--no-config --node-modules-dir=manual`; otherwise bundle with `bun build --target=browser` and run the bundle (Deno can't read `catalog:` versions). The log names the mode.
4. **browser** — the bundle in headless Chromium.
5. **hermes** — an IIFE bundle under `$HERMES_BIN`.

A missing engine prints `INCOMPLETE` and exits non-zero under `--require-all`, which the release scorecard uses. Today's smoke scripts exit 0 when the engine is missing (`math/scripts/smoke-browser.mjs:12`, `smoke-hermes.mjs:14`), so a release can pass on legs that never ran. `turbo.json`: `test:runtimes` `dependsOn: ["build"]`, `cache: false`.

**Manifest check** — `arki-library-check`, run from `lint`: folder = name, no `./*`, `types` + `default` under `dist/` for every entry, `sideEffects: false`, adapter deps are optional peers, a Boundaries tag is set.

First adopters: math, log, money, resilience, journal, bench, then string and date (B14).

## 7. `@arki/async`

A new foundation package, zero dependencies. It is not part of `resilience`, which handles failure policy on `cockatiel`, and not part of `clock`, which reads time. Async schedules work. Demand: 18 files define their own `sleep` (13 in apps, 5 in packages).

```ts
export class AsyncError extends Error {
  readonly code: 'ARKI_ASYNC_E001' | 'ARKI_ASYNC_E002';  // E001 invalid wait, E002 aborted
  readonly remediation: string;
}

export function sleep(ms: number, options?: { signal?: AbortSignal }): Promise<void>;

export interface Scheduled<A extends readonly unknown[]> {
  (...args: A): void;
  cancel(): void;            // drop the pending call
  flush(): void;             // run the pending call now
  readonly pending: boolean;
}

export function debounce<A extends readonly unknown[]>(
  fn: (...args: A) => void, wait: number,
  options?: { leading?: boolean; trailing?: boolean; maxWait?: number },
): Scheduled<A>;             // defaults: leading false, trailing true

export function throttle<A extends readonly unknown[]>(
  fn: (...args: A) => void, wait: number,
  options?: { leading?: boolean; trailing?: boolean },
): Scheduled<A>;             // defaults: both true
```

- `sleep`: 0 to 2,147,483,647 ms. Zero still waits a tick. An already-aborted signal rejects at once with E002 (`cause` = `signal.reason`). Settling clears the timer and the listener.
- The debounce and throttle contract is the familiar lodash one, so a migration is a one-line import change. Promise-returning variants were considered (Astra) and left out. Callers who need a result can await inside `fn`.
- Uses only `setTimeout`, `clearTimeout` and `AbortSignal`. It avoids `Promise.withResolvers` and `AbortSignal.any`, because Hermes lacks them. Nothing runs at import, and Vitest fake timers work without injection.
- Benchmarks (`@arki/bench`, contract-checked): `delay`, `lodash.debounce`/`throttle`, `es-toolkit`, `throttle-debounce`, `just-debounce-it`.

## 8. Waves

Each wave is a set of commits that leaves `turbo build typecheck lint test --filter='./packages/*'` green.

| Wave | Content | Proof |
|---|---|---|
| W1 Guardrails | eslint `library` preset, `tooling/library` (`arki-runtimes`, `arki-library-check`), Boundaries tags on every package (report-only), adopt math/log/money/resilience/journal/bench/string/date (B14); fix `arki-release/SKILL.md:70` (patch-only → breaking = minor). | `turbo test:runtimes --filter=` the 8; `turbo boundaries` lists only the known violations. |
| W2 Small contracts | `@arki/async` + migrate the 18 `sleep`s; B9, B10, B13, B15, B8; B2 closed. | Async contract tests + bench; `git grep` finds no local `sleep` definitions. |
| W3 Flatten | B17 moves, D3 merges, B16 moves, B18 per D2. One mechanical commit per family. | `bun install --frozen-lockfile`; `turbo build typecheck`; `arki-library-check` green; `turbo prune` + frozen install in a temp dir; `release:arki export-public` mirror equals the tree. |
| W4 Portable boundaries | B1, B4, B5, B7, B11, B12. | Core imports work with optional peers absent; golden fixtures; affected app builds. |
| W5 Composition | B6 (seo, feedback, auth/react), B3, template sync (`turbo/generators/templates/application`). | `turbo boundaries` zero violations, then switched to blocking; `turbo build --filter='./apps/*/start'`. |
| W6 Finish | Remove the remaining `./*` exports; changesets for every touched public package. | `arki-library-check` reports zero `./*`; scorecard dry run. Push and publish stay founder Stage 2. |

The flatten (W3) moves folders that other sessions may be editing. It runs only when `git status` is clean for those folders.

## 9. Left alone on purpose

- Every published name.
- `clock` stays separate from `date`.
- `/dot` entries with optional `@arki/dot` peers.
- `chat-ui`, `native-ui`, `text-bible` and `payments-native` stay shared. `payments-native` stays separate so native installs never pull in `stripe`.
- Mature engines (Temporal, Zod, cockatiel) are not rewritten just to reach zero dependencies.
- `dictionary`'s 419 MB of data.
- The `.release/` doctrine and the `tooling/*-config` names.
