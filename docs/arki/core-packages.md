# Arki — package tiers

Status: **proposed** (decisions A-01, A-06). Built from [research/01-market/arki-inventory.md](research/01-market/arki-inventory.md).

Every `@arki/*` package goes into exactly one tier. The tier decides its licence, its quality rule, and whether it appears on the docs site.

| Tier | Licence | Quality rule | On docs site |
| --- | --- | --- | --- |
| **1. Stack** | MIT | Stability contract; works inside the one supported stack (TanStack Start, oRPC, Drizzle, Postgres, Better Auth); server-only adapters declared honestly | Yes — the product |
| **2. Libraries** | MIT | Five runtimes + benchmarks vs competitors (current rule) | Yes — own section |
| **3. Licence** | Paid, source included | Tested inside the Stack; upgrade recipe per release | Yes — behind licence |
| **4. Out of brand** | Stays private or ships under its own name | None beyond today's | No |

## Tier 1 — Stack (21)

| Area | Packages | Today | Work before launch |
| --- | --- | --- | --- |
| Kernel | `dot`, `feature`, `env` | public | `dot new` must scaffold a deployable app |
| HTTP / API | `http`, `contracts`, `tanstack-start` | `tanstack-start` private | publish `tanstack-start` |
| Data | `db`, `journal`, `kv` | public | — |
| Auth | `auth` | **private** | publish; fix README (still says pnpm / Next.js) |
| Jobs | `queue`, `schedule` | **private** | publish; add a Postgres-backed queue option next to BullMQ (A-11); failed-job inspection + retries documented |
| Mail | `emails` | **private** | publish |
| Billing | `payments` | public | security review before selling (see strategy § 8) |
| Observability | `log` | public | — |
| Testing | `testing` | **private** | publish |
| UI | `ui`, `design-systems`, `theme` | public | Stack default is **workbench** (A-10) |
| AI (A-12) | `ai`, `chat-ui` | **private** | publish; wire into `dot new` (frontend chat + backend AI route); scope set by research round 03 |

Phase 2 candidates (Laravel parity gaps buyers ask for): `fs` (storage), `intl` (localisation), a notifications package (does not exist yet).

## Tier 2 — Libraries (11)

`math`, `money`, `date`, `string`, `clock`, `resilience`, `assert`, `ts`, `bench`, `react-hooks`, `icons`.

Usable on their own in any TS project. They are the top of the funnel: benchmarks and npm downloads bring people to the Stack. `money`, `date`, `clock` and `resilience` are also used by the Stack.

## Tier 3 — Licence candidates (5)

| Package | Paid feature it becomes |
| --- | --- |
| `sitekit` | App shell: sidebar, page container, settings layouts |
| `admin` | Operator screens; later the Arki Console contract |
| `waitlist` | Waitlist + launch flow with MCP admin |
| `meter` | Cookieless product analytics wiring |
| `rich-text` | Block editor |

Plus finished workflows that are not packages yet: workspace onboarding, subscription and entitlement screens, billing history (journal browser).

## Tier 4 — Out of brand (~30)

- Domain-specific: `text-bible`, `books-import`, `usfm-to-json`, `poetry`, `dictionary`, `mw-dictionary`, `text-hyphen`, `text`, `text-operations`, `games-*`, `domains-*`.
- Useful but not Stack: `geo`, `scraping`, `rss`, `images`, `diff-engine`, `formats`, `content`, converters (`html-to-md`, `html-to-text`, `md-to-html`, `md-to-pdf`), `text-embeddings`, `code-editor`, `spinners`, `react-fullscreen`, `react-sounds`.
- Not ready / later: `offline`, `native-ui`, `payments-native`.
- Internal: `f04-config` (moved to `apps/evervest/config`); app brand design systems live in each app's `design` workspace.

These keep serving the founder's apps. Any of them can move up a tier later by decision, not by drift.

## Open questions for the founder

1. ~~Stack default design system~~ — workbench (A-10).
2. ~~Redis-only queue?~~ — add a Postgres option (A-11).
3. ~~`ai` and `chat-ui`: licence or Stack?~~ — Stack (A-12).
