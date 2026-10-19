# Arki — package tiers

Status: **accepted** (A-09), updated by the later [decisions](decisions.md), the [fleet RFC](../rfcs/2026-10-17-fleet-packages.md) and the final AI founder decisions linked below. Package counts are not policy.

The tiers describe supported product scope and commercial bundles. They do not prove release readiness or npm publication. Placement is separate: `packages/<name>` is `@arki/<name>`; `fleet/<name>` is private `@fleet/<name>` and never released. A private Arki package is still Arki, not fleet or out of brand.

| Tier                           | Licence                                  | Quality rule                                                                                                                                                                                                               | On docs site                 |
| ------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **1. Stack**                   | MIT                                      | Stability contract; works inside the supported stack (TanStack Start, oRPC, Drizzle, Postgres, Better Auth); server-only adapters declared honestly; ships `llms.txt` + agent guide; README examples compile (`test:docs`) | Yes — the product            |
| **2. Libraries**               | MIT                                      | Five runtimes + benchmarks vs competitors (A-05 applies this rule to leaf libraries); ships `llms.txt` + agent guide; README examples compile (`test:docs`)                                                                | Yes — own section            |
| **3. Licence bundles**         | Paid, source included                    | Tested inside the Stack; upgrade recipe per release                                                                                                                                                                        | Yes — behind licence         |
| **4. Outside supported scope** | No new licence or publication commitment | Admission requires a decision                                                                                                                                                                                              | No supported-product promise |

## Tier 1 — Stack

| Area           | Packages                        | Admission / remaining work                                                                                                               |
| -------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel         | `dot`, `cli`, `env`             | `cli` admitted by A-32; `feature` is an `@arki/dot` subpath. `dot new` must scaffold a deployable app.                                   |
| HTTP / API     | `http`, `contracts`             | `@fleet/tanstack-start` is fleet infrastructure, not an admitted `@arki/tanstack-start` package.                                         |
| Data           | `db`, `journal`, `kv`           | Supported Stack scope.                                                                                                                   |
| Auth           | `auth`                          | Supported Stack scope; manifest is not private.                                                                                          |
| Jobs           | `queue`, `schedule`             | Publication admitted by A-29, conditional on the docs standard and scorecard; Postgres queue option required by A-11.                    |
| Mail           | `mail`                          | Formerly called `emails` (A-28).                                                                                                         |
| Billing        | `payments`                      | Security review before selling (strategy § 8).                                                                                           |
| Observability  | `log`                           | Supported Stack scope.                                                                                                                   |
| Reliability    | `failure`, `lock`               | Admitted by A-28.                                                                                                                        |
| Live updates   | `live`                          | Admitted by A-31, superseding A-28's “not yet” clause.                                                                                   |
| Testing        | `testing`                       | Publication admitted by A-29, conditional on the docs standard and scorecard.                                                            |
| UI             | `ui`, `design-systems`, `theme` | Stack default is **workbench** (A-10).                                                                                                   |
| Administration | `admin`                         | Stack by A-20; free shell must drop its `meter` hard dependency. Private status does not undo admission.                                 |
| AI             | `ai`, `chat-ui`                 | Stack by A-12; publication admitted by A-29, conditional on the docs standard and scorecard. `dot new` includes frontend and backend AI. |

At the 2026-10-19 manifest check, admitted Stack packages with `private: true` are `admin`, `ai`, `chat-ui`, `queue`, `schedule` and `testing`. The other packages in this table have `private: false` or omit the flag. These are manifest facts, not verified npm publication or completed release gates.

Phase 2 candidates remain `fs` (storage) and `intl` (localisation), both existing private Arki packages. Notifications ship as a recipe first; A-16's conditional notifications entry is under the current `mail` name, not a new package. None of these candidates is admitted by this catalog.

### AI architecture and names

The final [naming decisions § 6](research/12-ai-split/naming.md#6-founder-decisions-2026-10-17) and [architecture decisions § 10](research/12-ai-split/synthesis.md#10-founder-decisions-2026-10-17) define `@arki/ai`, `@arki/agents`, `@arki/embeddings`, `@arki/search`, `@arki/speech`, `@arki/guardrails` and `@arki/ai-cost`. The flow runner is `@arki/agents/flow`; reranking is `@arki/embeddings/rerank`; local embeddings use `@arki/embeddings/transformers`. `ocr`, `extraction` and `image-generation` are reserved names without implementation commitments. `chat-ui`, `mcp` and `testing/ai` keep their names.

These architecture decisions do not blanket-admit every AI package for publication. Only existing admission decisions apply. Current manifests include private `embeddings` and the old private `text-embeddings`; the approved absorption removes `text-embeddings` rather than keeping both. The other new package names above are planned names, not claims that packages already exist or are published.

## Tier 2 — Libraries

`math`, `money`, `date`, `string`, `clock`, `resilience`, `assert`, `ts`, `bench`, `react-hooks`, `icons`, `async`, `schema`, `expr`, `cas`.

These are admitted reusable libraries. Their manifests are not private at the 2026-10-19 check; npm publication was not checked. They are usable independently; `money`, `date`, `clock` and `resilience` also serve the Stack.

## Tier 3 — Licence bundle candidates

These retain the commercial ideas accepted with A-09. They describe paid product bundles, not exclusive package classifications or permission to release fleet code.

| Bundle                                               | Existing building block / boundary                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| App shell: sidebar, page container, settings layouts | `@fleet/sitekit` is private fleet infrastructure; a reusable paid bundle must respect the fleet boundary.   |
| Operator screens and future Arki Console             | `@arki/admin` is free Stack infrastructure (A-20); premium Foreman modules remain possible under A-18/A-20. |
| Waitlist + launch flow with MCP admin                | `@arki/waitlist` remains private and outside the admitted free scope.                                       |
| Cookieless product analytics wiring                  | `@fleet/meter` is private fleet infrastructure; the bundle idea does not admit it to Arki.                  |
| Block editor                                         | `@arki/rich-text` remains private and outside the admitted free scope.                                      |

Plus finished workflows that are not packages yet: workspace onboarding, subscription and entitlement screens, billing history (journal browser). Premium AI workflows may live in the licence (A-12).

## Tier 4 — Outside supported scope

Current private Arki packages outside the admitted Stack and Libraries lists: `code-editor`, `content`, `content-build`, `content-react`, `diff`, `domains`, `embeddings`, `formats`, `fs`, `geo`, `images`, `intl`, `mcp`, `md-to-pdf`, `native-ui`, `offline`, `payments-native`, `react-fullscreen`, `react-sounds`, `rich-text`, `rss`, `scraping`, `seo`, `text`, `text-embeddings`, `waitlist`. AI architecture and commercial candidates above do not independently grant publication admission.

Fleet manifests are `books-import`, `dictionaries`, `dictionary`, `feedback`, `games`, `games-solitaire`, `games-solitaire-ui`, `games-sudoku`, `meter`, `mw-dictionary`, `poetry`, `sitekit`, `tanstack-start`, `text-bible`, `text-hyphen`. All use `@fleet/*` and `private: true`. They serve the founder's apps under the fleet RFC, outside the Arki release inventory.

Old inventory names such as `diff-engine`, `domains-*`, `usfm-to-json`, `html-to-md`, `html-to-text` and `md-to-html` are not current package manifests. `f04-config` moved to `apps/evervest/config`; app brand design systems live in each app's `design` workspace. Historical names do not establish current packages or admissions.

Any later admission requires an explicit decision under A-06 and the release gates. A package's presence in `packages/`, a `private: false` flag or an architecture plan alone is insufficient.
