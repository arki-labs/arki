# Demo bar

The standard every arki demo meets. No demo ships on vibes. Terms: [wave, candidate, X-ray](./glossary.md).

## 1. What a demo is

A demo is a real app built only on published `@arki/*` packages.

- It is a nested repo at `demos/<name>`. The monorepo gitignores it.
- It has its own `bun.lock`.
- It is registered in `arki.release.config.ts`, in the `demos` array. Each entry is `{ name, repo, path }`, for example `{ name: 'drop-studio', repo: 'arki-labs/drop-studio', path: 'demos/drop-studio' }`.
- The founder creates `arki-labs/<name>` and pushes. Agents never push.

## 2. Dependency check

This is the first step of every demo task.

1. List every `@arki/*` package the demo needs.
2. Each one must be public and in a release [wave](./glossary.md), or already published.
3. If one is private or not admitted, stop. Report which admission is needed.

## 3. The bar

A demo is done when all of these are true.

- [ ] README with one command to run it.
- [ ] `docs/concept.md`: what it is and why it exists.
- [ ] `docs/lib-gaps.md`: every gap found in `@arki` (format below).
- [ ] An [X-ray](./glossary.md) surface that shows what the app really did.
- [ ] E2E stories for the journeys in section 4.
- [ ] `arki.deps.json` with exact pins (no `^`), and a committed `bun.lock`.
- [ ] A Coolify recipe (how the app is built and deployed).
- [ ] A public URL.
- [ ] A showcase paragraph for the site.
- [ ] `typecheck`, `lint`, `test` and `format` are green.

### `lib-gaps.md` row format

One Markdown table. One row per gap. A script parses it, so keep the columns.

| Column | Meaning |
| --- | --- |
| `#` | Row number. Never reused. |
| `Package` | The package in backticks, such as `@arki/db`. |
| `Gap` | What is missing or wrong, in plain words. |
| `Found` | Phase or date when it was found. |
| `Status` | `open`, `fixed in <pkg>@<version>`, or `adopted here`. Add a short note after a dash. |

A gap is evidence for the framework. Fix the package, not the demo. Found a gap? Good. That is the demo doing its job.

## 4. Scenario contract

Each demo has 3 to 5 named journeys in `docs/journeys.md`.

Each journey has:

- setup,
- the expected result,
- one failure case,
- a reset command,
- a captured `dot explain --json` and `dot doctor --json`.

E2E covers what makes the demo distinct. It does not cover UI detail.

Template for one journey:

```md
## J1 Brief to storefront

**Setup:** `bun run reset`, then `bun dev`. Start as the merchant.
**Steps:** upload the brief, accept the collection, publish.
**Expected:** the storefront lists the new products. X-ray shows one trace per step.
**Failure case:** the AI provider is down. The screen says so. No product is invented.
**Reset:** `bun run reset`.
**Captured:** `docs/journeys/j1.explain.json`, `docs/journeys/j1.doctor.json`.
**E2E:** `e2e/j1-brief-to-storefront.spec.ts`.
```

## 5. AI stance

- Read `LLM_PROVIDER`. The default is `ollama`. Use `openai` only when it is set.
- With no provider, show a "set up a provider" screen. Never show a fake answer.
- X-ray shows the provider and the cost of every AI call.
- AI calls go through `@arki/ai` (admitted as it is today, A-40). Demos use link mode until it is published.
- The browser never calls a provider. Frontend suggestions go through the demo's server, so provider keys stay there and every call shows in X-ray.

## 6. Laptop start

- Seed data ships with the demo. `bun run reset` returns it to the seed.
- The README lists every service the demo needs.
- There is one start path.
- Local inference is an explicit step. It shows status and has a cancel button.
- Visitors who cannot run services get a recorded tour.

## 7. Lessons

Pick 1 or 2 journeys per demo. Each becomes a lesson page.

Lesson pages quote the demo source with a `from=` fence:

````md
```ts from="path/to/file.ts#region-name"
```
````

The path is relative to the package or repo root. The region is the code between `// #region region-name` and `// #endregion` in that file. The docs test fails if the block differs from the source, or if the file or region is missing. `bun run test:docs -- --write` refreshes the blocks. The parser is `tooling/library/src/doc-examples.ts`.

## 8. Release checks

| Command | What it does |
| --- | --- |
| `bun run arki:npm` | Installs the exact published versions pinned in `arki.deps.json`. |
| `bun run arki:link` | Links packages from the monorepo while a lib is being changed. |
| `bun run arki:candidate <dir> [<dir>...]` | Copies the demo to a temp folder, installs the [candidate](./glossary.md) tarballs, then typechecks, tests and builds. Prints a JSON report. |
| `bun release:arki demo-check --demo <name> --candidate <dir>` | Runs `arki:candidate` and records `candidate.json.checks["demo:<name>"]`. A demo missing on disk is `deferred`, never a pass. |

Scorecard dimensions:

- `demo-impact`: a releasing package must pass the candidate check of each demo that uses it.
- `demo-lag`: a demo's pins must not fall behind the published versions. Warning only until two waves have shipped with it.
