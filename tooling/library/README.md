# @arki/library-tooling

Private tooling for the `@arki/*` packages. It ships bins only, no library entry.

| Bin                  | What it does                                                                                                                            | Where it runs                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `arki-library-check` | Checks a package manifest and, for public packages, its agent docs. `--all` checks every package against `library-check-baseline.json`. | root `bun run library-check` (a dependency of `turbo lint`)        |
| `arki-layers`        | Checks imports against the Boundaries layer rules.                                                                                      | root `bun run layers`                                              |
| `arki-runtimes`      | Proves a package runs on Node, Bun, Deno, a browser and Hermes.                                                                         | package script `test:runtimes`                                     |
| `arki-doc-examples`  | Typechecks every code block in `README.md` and `docs/agent-guide.md` against the built package, and runs the `run` blocks on Bun.       | package script `test:docs` (turbo task `test:docs`, after `build`) |

## Agent-first docs

Every public package (`"private"` is not `true`) ships three files:

1. `README.md`: the long overview, for humans. Its code blocks compile.
2. `llms.txt`: the index an agent reads first. Short, fixed sections.
3. `docs/agent-guide.md`: the model, the task map, the rules, the errors, and how to verify.

An agent reads `llms.txt`, then the guide, then copies README blocks.

The checks prove the code blocks. They do not prove the prose. A claim that matters becomes a block, a type test, or it stays unchecked.

### `llms.txt`

It follows [llmstxt.org](https://llmstxt.org/) with fixed sections:

```md
# @arki/<name>

> One or two sentences. What it is. What it is not.

Optional short paragraph: the one caution every agent must know.

## Import paths

- `@arki/<name>`: the core. <the names an agent will type>
- `@arki/<name>/pg`: optional peer `pg`. <what it adds>
- Components: `@arki/ui/button`, `@arki/ui/card`, `@arki/ui/dialog`

## Start here

- [Agent guide](docs/agent-guide.md): read first.
- [Verify](docs/agent-guide.md#verify): the commands to run after a change.
- [README](README.md): the long overview.

## By task

- [<verb phrase>](docs/agent-guide.md#<anchor>)

## Rules that bite

- <one sentence each; the mistakes agents make>

## Optional

- [Design spec](docs/specs/...)
```

- Line 1 is exactly `# @arki/<name>`. The next non-blank line starts with `> `.
- The four H2s come in this order. `## Optional` may follow. No other H2.
- `Import paths` names every `exports` key (not `./package.json`, not wildcards) as a backticked specifier. One bullet may hold several.
- At most 80 lines and 8 KiB. Over 60 lines is a warning.
- Every relative link resolves inside the package. Anchors are GitHub heading slugs.

### `docs/agent-guide.md`

Required H2s, exact names, in this order: `The model`, `Task map`, `Rules that bite`, `Errors`, `Verify`. Other H2s may sit between them.

- `The model`: numbered facts. What the package is and is not.
- `Task map`: one H3 per task. Numbered steps. Name the library files. Copyable blocks.
- `Rules that bite`: the mistakes, one line each. Guarantees and limits go here.
- `Errors`: a table: code, meaning, what to do.
- `Verify`: the exact commands after a change. At least `bun run test:docs` or the package's tests.

The first paragraph names `llms.txt` and the file that wins when they disagree. A package with a `./dot` export shows `dot explain --json | jq '.data…'` and `dot doctor --json | jq '.data…'` under `Verify`. Only the Dot guide documents `dot new`; other guides link to it. There is no size limit.

### The fence grammar

Words go after the language, space separated. `ts`, `tsx`, `typescript`, `js`, `jsx` and `javascript` blocks are examples. `sh`, `json`, `md`, `text` and the rest are ignored.

`````md
````ts ← default: typecheck as its own module
```ts run                      ← typecheck, then `bun` runs it; a throw or non-zero exit fails
```ts run expect               ← as `run`; the next fence must be ```text and equal stdout (trimmed)
```ts from="examples/x.ts#name" ← not compiled; must equal that `// #region name` of a tested file
```ts continue                 ← appended to the previous block of this file (tutorial steps)
```ts skip="needs Stripe keys" ← not compiled; reason required, counted in the summary
````
`````

````

- `run` goes on the first block of a chain and applies to the whole chain. A good `run` block asserts its outcome: `if (got !== want) throw new Error(...)`. An import that only loads proves nothing.
- `run expect`: the ```` ```text ```` fence right after the block is the expected stdout. A mismatch fails the block.
- `from="path#region"`: the block mirrors the lines between `// #region name` and `// #endregion` in that file, dedented. The file is tested elsewhere, so the block is not compiled. `--write` refreshes the block from the file.
- A `continue` after a skipped block is skipped too, with the same reason.
- Fences may be indented (blocks in list items); the indent is stripped. Tilde fences and CRLF files work. A fence inside a longer outer fence is text.
- Banned in blocks: `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`. A negative claim ("this must not compile") goes in the package's `*.test-d.ts`.
- A block may import the package by name (`@arki/<name>`, `@arki/<name>/sub`), its `dependencies`, `peerDependencies`, `devDependencies`, `node:` builtins, and the docs fixture `./fixture.ts`. No other relative imports. The root `node_modules` would resolve more; a consumer would not.
- `skip="…"` is for what cannot run here: a real Postgres server, the network, a browser, an app's lint config. "Uses the app's tables" is not a reason: that is what the docs fixture is for.

### The docs fixture: app-shaped examples that run

Many blocks show how an app uses the package: its tables, its database, its contracts. The page does not define them, so the block cannot compile alone. The docs fixture provides them, once per package, in plain sight.

- The package writes `docs/examples/fixture.ts`: named exports only, for example an in-memory PGlite `db` from `@arki/db/runtime-local` and the `users` table. Its imports follow the block rules.
- A block imports what it uses on its first line: `import { db, users } from './fixture.ts';`. A `continue` step uses what the first step imported. `run` and `run expect` work as usual: each run is a fresh process, so it gets a fresh fixture.
- Add `docs/examples/tsconfig.json` (extends `../../tsconfig.json`, `noEmit`, `allowImportingTsExtensions`, `include: ["./*.ts"]`), so eslint's project service lints the fixture like any other file.
- A fixture that opens PGlite closes it on `beforeExit` (see `packages/db/docs/examples/fixture.ts`): Bun exits with 99 when a PGlite instance is left open.
- The page links the fixture file (relative to the page: `[docs fixture](docs/examples/fixture.ts)` from `README.md`, `examples/fixture.ts` from `docs/agent-guide.md`). Say in one sentence what it holds.

Why an import and not a hidden prelude: readers copy blocks. A prelude the harness prepends makes a block that works only inside the harness. The import names the file, the link opens it, and a reader replaces `./fixture.ts` with their own module.

How it works: `.cache/doc-examples/fixture.ts` re-exports `../../docs/examples/fixture.ts`, so TypeScript and Bun resolve `./fixture.ts` like any relative file. The fixture is compiled in the same program, so a type error in it is reported at `docs/examples/fixture.ts:<line>`. It also obeys the block bans (DOCX_E006). Every `run` block that imports it tests it; a fixture with logic of its own also gets a vitest test.

How it works: blocks are written to `.cache/doc-examples/<file>-<line>.ts` (first line `// from README.md:12`), with a tsconfig that extends the package's own. One `ts.Program` checks them all. The package resolves itself through `node_modules/@arki/<name>` and its `exports`, so types come from `dist/*.d.ts`. `run` blocks then run serially with `bun`, from the package directory, with only `PATH` and `HOME`, 30 s each. Nothing is written outside `.cache/doc-examples/`.

```sh
bun run test:docs                 # in a package: arki-doc-examples
arki-doc-examples --no-run        # typecheck only
arki-doc-examples --write         # refresh every from= block from its region
arki-doc-examples --json          # { examples, modules, compiled, ran, skipped, skippedBlocks, failures }
bun run test:docs                 # at the root: turbo run test:docs --continue
```

## Generated files

Each tool writes one file from the package's own sources. Run them in a package folder.

### `arki-llms`

Writes the `## Import paths` section of `llms.txt` from `package.json` `exports`, so DOC_E006 cannot drift.

- One bullet per export key (not `./package.json`, not wildcards): the specifier, the first line of the entry module's top comment, and up to 12 exported names (values first, then `types ...`).
- The section lives between `<!-- llms:start -->` and `<!-- llms:end -->`. Text outside the markers stays as written. A section without markers is replaced whole and gets them.
- The entry module is the source behind the export (`dist/x.js` reads `src/x.ts`), so no build is needed.
- It stops with an error when the result would pass 80 lines or 8 KiB (the DOC_E007 limits, `LLMS_MAX_LINES` and `LLMS_MAX_BYTES` in `docs.ts`).

```sh
arki-llms            # print the generated bullets
arki-llms --write    # update llms.txt
arki-llms --check    # exit 1 with a diff when llms.txt is stale
```

### `arki-api-index`

Lists every public export of a built package as `api.json`: subpath, name, kind, signature and the first JSDoc paragraph. `errorCodes` holds the codes of `arki-error-index`.

- It reads `exports`, takes each subpath's `types` file, and asks the TypeScript compiler for its exports. Run it after `build`.
- Wildcard subpaths and `package.json` are skipped. A subpath whose types are not built is skipped and named on stderr.
- `candidate` writes `dist/api.json` into every tarball, so each published version carries its API.

```sh
arki-api-index [--dir <packageDir>] [--out <file>]   # JSON to stdout without --out
```

### `arki-api-diff`

Compares two `api.json` files. An entry is subpath plus name. It is added or removed when only one side has it, and changed when its signature differs.

- `--docs <packageDir>` searches `README.md`, `docs/**/*.md` and `llms.txt` for each removed or changed name, as a whole word, and prints `file:line`. A rename then cannot leave stale pages.
- `--json` prints `{ added, removed, changed, docMentions }`. `apiDiffSchema` reads it back; the upgrade guide uses it.

```sh
arki-api-diff --from old/api.json --to dist/api.json [--docs .] [--json]
```

### `arki-error-index`

Reads every error code under `src/` and writes `dist/errors.json`, the data behind `https://arki.dev/errors/<code>`.

- Thrown codes: a string property of an object named `*_ERROR_CODES` or `*ErrorCode(s)`. The property's JSDoc is the entry.
- Failure codes: a `defineFailure('<pkg>.<code>', ...)` call. The JSDoc of its declaration is the entry.
- In the JSDoc, the summary says what happened, `@fix` says what to do, and `@verify` gives the command that proves the fix.
- `arki-library-check` reports ERR_E001 for each code without `@fix` or `@verify`.
- Not indexed: a `code:` string inside `new XError(...)`.

```sh
arki-error-index [--out dist/errors.json]
```

### `arki-runtimes --write-readme`

Runs the package's runtime tests and writes one row per engine (result, version tested, UTC date) between `<!-- runtimes:start -->` and `<!-- runtimes:end -->` in `README.md`.

- An engine not run this time (`--only`) keeps its row.
- Run it on the Node version CI uses; the row records the version it ran.

```sh
arki-runtimes --write-readme [--only node,bun] [--require-all]
```

## Rules and repairs

`arki-library-check` (DOC and SRC rules: public packages only, and DOC_E004 to DOC_E012 on a file fire only when that file exists; TYPES rules: every `packages/*` library, private ones too):

| Rule     | Meaning                                                              | Repair                                                                                                                               |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| DOC_E001 | no README.md                                                         | Write one.                                                                                                                           |
| DOC_E002 | no llms.txt                                                          | Copy the shape above, or the generator template `turbo/generators/templates/package/llms.txt.hbs`.                                   |
| DOC_E003 | no docs/agent-guide.md                                               | Copy `turbo/generators/templates/package/docs/agent-guide.md.hbs`.                                                                   |
| DOC_E004 | llms.txt must start with `# @arki/<name>` then one `> ` summary line | Fix line 1 and the summary line.                                                                                                     |
| DOC_E005 | llms.txt missing or misordered section                               | Use exactly `Import paths`, `Start here`, `By task`, `Rules that bite`, then optional `Optional`. Move other lists under `Optional`. |
| DOC_E006 | llms.txt "Import paths" differs from exports                         | Add each `missing` subpath; remove each `extra` one.                                                                                 |
| DOC_E007 | llms.txt over budget (80 lines or 8 KiB)                             | Group bullets; move detail to the guide.                                                                                             |
| DOC_E008 | broken local link or anchor                                          | Fix the path, or the anchor to match the heading slug.                                                                               |
| DOC_E009 | link leaves the package                                              | Link inside the package or to an `https:` URL. The tarball has nothing outside.                                                      |
| DOC_E010 | agent guide missing or misordered section                            | Add the five H2s in order.                                                                                                           |
| DOC_E011 | agent guide "Verify" lacks dot explain --json and dot doctor --json  | Add both commands, each piped to `jq` with a path under `.data`.                                                                     |
| DOC_E012 | package.json "files" does not ship a doc file                        | Add `llms.txt` and `docs/**` (or the linked files) to `files`.                                                                       |
| DOC_E013 | no "test:docs" script                                                | Add `"test:docs": "arki-doc-examples"` and the devDependency `"@arki/library-tooling": "workspace:*"`.                               |
| DOC_E014 | no CHANGELOG.md                                                      | Add one; the release tooling appends to it.                                                                                          |
| DOC_E015 | no LICENSE                                                           | Add the MIT `LICENSE` file.                                                                                                          |
| DOC_E016 | no AGENTS.md                                                         | Add one; see DOC_E018 for its shape.                                                                                                 |
| DOC_E017 | README H2s missing or misordered                                     | The first four H2s are `Install`, `Quick start`, `When not to use this`, `Runtime support`; `Public imports`, `Failure behaviour`, `Limits`, `Documentation`, `Support` follow anywhere. Body text is free. The list is `README_SECTIONS` in `docs.ts`, shared with the release readiness table. |
| DOC_E018 | AGENTS.md lacks the role line or a required section                  | Line 1 is `AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.`; add H2s `Laws`, `Changing this package`, `Verify`.       |
| DOC_E019 | banned word in README, docs or llms.txt                              | Drop simply, just, easy, powerful, blazing, seamless, robust, leverage, might, should probably. Fenced and inline code are skipped.  |
| SRC_E001 | string literal equals the package version                            | Read the version from `package.json` or a generated `src/version.ts` (that file is skipped). Applies to `src/**` of public packages. |
| DOC_W001 | forward-looking language                                             | Say what exists today. Plans go in an RFC.                                                                                           |
| DOC_W002 | llms.txt over 60 lines                                               | Group bullets.                                                                                                                       |
| TYPES_E001 | export entry exposes Zod types (`./zod` entries and `@arki/contracts` are exempt) | Take a Standard Schema (`@arki/schema`) in the entry, or move the Zod helper to a `./zod` subpath.                                   |
| TYPES_W001 | export entry types not built: Zod check skipped                      | Build the package (`turbo run build --filter=@arki/<name>`), then run the check again.                                               |

`arki-doc-examples`:

| Rule      | Meaning                                        | Repair                                                                                             |
| --------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| DOCX_E001 | example does not typecheck                     | Add the imports, chain the block with `continue`, fix the call to the real API, or `skip="<why>"`. |
| DOCX_E002 | run example failed or timed out                | Fix the block, or drop `run`. The message ends with the last 20 lines of stderr.                   |
| DOCX_E003 | skip without a reason                          | Write `skip="<why>"`, quoted.                                                                      |
| DOCX_E004 | continue with no previous example in this file | Remove `continue`, or put the first step before it.                                                |
| DOCX_E005 | unknown fence word or unclosed fence           | Use only `run`, `continue`, `skip="…"`; close the fence.                                           |
| DOCX_E006 | forbidden construct                            | Use the inferred type; move negative claims to a `*.test-d.ts`.                                    |
| DOCX_E007 | undeclared or relative import                  | Declare the package in `package.json`, or import the package by name.                              |
| DOCX_E008 | no build output                                | Run `bun run build` first (turbo's `test:docs` does).                                              |
| DOCX_E013 | imports `./fixture.ts`, no fixture file        | Write `docs/examples/fixture.ts`, or import the names from the package.                            |
| DOCX_E014 | imports `./fixture.ts`, page does not link it  | Link `docs/examples/fixture.ts` from the page and say what it holds.                               |

Reading a DOCX_E001 line:

```text
README.md:21  DOCX_E001  example does not typecheck: TS2345 Argument of type 'number' is not assignable to parameter of type 'string'.
```

`README.md:21` is the Markdown line of the code that fails (not the fence line). `TS2345` is the TypeScript code. `TS2304 Cannot find name` usually means a fragment: add the import or `continue`. `TS2305 has no exported member` usually means the docs drifted from the code.

## The baseline

`library-check-baseline.json` lists known errors, each with a reason. Only errors outside it fail `arki-library-check --all`. An entry that no longer matches an error is STALE and fails the run, so the file only shrinks: when a package is migrated, delete its entries.

When other work changes a package's docs, regenerate the file and review the diff:

```sh
bun tooling/library/src/library-check.ts --all --update-baseline --reason "lesson 13 wave A|B: docs backlog"
```

It drops stale entries, keeps the reason of entries that still match, and adds each new error with `--reason`. Adding an entry is a reviewed change, never a silent one.

Example failures have no baseline. A package gets its `test:docs` script only when it is migrated, so unmigrated packages never run the compiler.

## Measured backlog

`arki-doc-examples --no-run` over the 28 public packages on 2026-10-16, before migration (dist as built that day):

| Package | Examples | Failures | Failing blocks | By rule |
| --- | --- | --- | --- | --- |
| assert | 1 | 0 | 0 | - |
| async | 7 | 17 | 10 | DOCX_E001=17 |
| bench | 6 | 12 | 7 | DOCX_E001=12 |
| cas | 5 | 0 | 0 | - |
| clock | 3 | 4 | 4 | DOCX_E001=3 DOCX_E007=1 |
| contracts | 7 | 10 | 9 | DOCX_E001=10 |
| date | 9 | 46 | 22 | DOCX_E001=45 DOCX_E007=1 |
| db | 16 | 69 | 41 | DOCX_E007=1 DOCX_E001=68 |
| design-systems | 4 | 0 | 0 | - |
| dot | 25 | 0 | 0 | - (migrated: the pilot; 6 skipped) |
| env | 3 | 8 | 8 | DOCX_E001=8 |
| expr | 6 | 7 | 6 | DOCX_E001=7 |
| failure | 12 | 71 | 32 | DOCX_E001=71 |
| http | 13 | 66 | 38 | DOCX_E001=65 DOCX_E007=1 |
| icons | 1 | 1 | 1 | DOCX_E001=1 |
| journal | 17 | 196 | 103 | DOCX_E001=196 |
| kv | 4 | 2 | 2 | DOCX_E001=2 |
| lock | 17 | 2 | 2 | DOCX_E007=2 |
| log | 6 | 18 | 13 | DOCX_E001=16 DOCX_E007=2 |
| math | 24 | 28 | 25 | DOCX_E001=28 |
| money | 11 | 19 | 17 | DOCX_E001=19 |
| payments | 0 | 0 | 0 | - |
| react-hooks | 1 | 1 | 1 | DOCX_E001=1 |
| resilience | 9 | 18 | 13 | DOCX_E001=18 |
| string | 10 | 14 | 14 | DOCX_E001=14 |
| theme | 1 | 1 | 1 | DOCX_E001=1 |
| ts | 2 | 0 | 0 | - |
| ui | 1 | 1 | 1 | DOCX_E008=1 |
| **total** | **221** | **611** | **370** | |

A failing block counts once, however many TypeScript errors it has. Most DOCX_E001 failures are fragments (`TS2304 Cannot find name`: no import, or a helper the block never declares). Real drift: `TS2305` in icons and react-hooks (named exports that do not exist), `TS2339` / `TS2554` in env, failure, http and math. DOCX_E008 means that package's `dist/` was stale that day; `bun run build` fixes it. Re-measure with `arki-doc-examples --no-run` in each package.
````
