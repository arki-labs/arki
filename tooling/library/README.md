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
```ts continue                 ← appended to the previous block of this file (tutorial steps)
```ts skip="needs Stripe keys" ← not compiled; reason required, counted in the summary
````
`````

````

- `run` goes on the first block of a chain and applies to the whole chain. A good `run` block asserts its outcome: `if (got !== want) throw new Error(...)`. An import that only loads proves nothing.
- A `continue` after a skipped block is skipped too, with the same reason.
- Fences may be indented (blocks in list items); the indent is stripped. Tilde fences and CRLF files work. A fence inside a longer outer fence is text.
- Banned in blocks: `any`, `as unknown as`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`. A negative claim ("this must not compile") goes in the package's `*.test-d.ts`.
- A block may import the package by name (`@arki/<name>`, `@arki/<name>/sub`), its `dependencies`, `peerDependencies`, `devDependencies`, and `node:` builtins. No relative imports. The root `node_modules` would resolve more; a consumer would not.
- Database examples use PGlite inside the block, or `skip="needs Postgres"`.

How it works: blocks are written to `.cache/doc-examples/<file>-<line>.ts` (first line `// from README.md:12`), with a tsconfig that extends the package's own. One `ts.Program` checks them all. The package resolves itself through `node_modules/@arki/<name>` and its `exports`, so types come from `dist/*.d.ts`. `run` blocks then run serially with `bun`, from the package directory, with only `PATH` and `HOME`, 30 s each. Nothing is written outside `.cache/doc-examples/`.

```sh
bun run test:docs                 # in a package: arki-doc-examples
arki-doc-examples --no-run        # typecheck only
arki-doc-examples --json          # { examples, modules, skipped, failures }
bun run test:docs                 # at the root: turbo run test:docs --continue
```

## Rules and repairs

`arki-library-check` (DOC rules: public packages only, and DOC_E004 to DOC_E012 on a file fire only when that file exists; TYPES rules: every `packages/*` library, private ones too):

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
