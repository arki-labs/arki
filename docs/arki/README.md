# Arki — commercial product

Arki is the `@arki/*` package set (about 54 packages under `packages/`) turned into a product people pay for. Laravel is the reference model: a free framework that feeds paid tools.

**Positioning (proposed):** *Arki is the maintained TypeScript SaaS foundation for people who ship many products on servers they control.*

**Status:** Strategy accepted 2026-10-14 (A-01…A-11). Execution plan: [plan.md](plan.md). See [decisions.md](decisions.md).

## Where things are

The [core principles](principles.md) apply across all Arki packages, including
OpenTelemetry throughout the framework and easy instrumentation for plugins and features.

| File | What it holds |
| --- | --- |
| [plan.md](plan.md) | **The execution plan**: weeks 1–13 task by task, Laravel parity matrix, AI pillar, licence product, gates, months 4–12. |
| [strategy.md](strategy.md) | The recommended strategy: product, pricing, how to beat Laravel, risks, first 90 days. Start here. |
| [core-packages.md](core-packages.md) | Every `@arki/*` package sorted into four tiers: Stack, Libraries, Licence, Out of brand. |
| [decisions.md](decisions.md) | Decisions the strategy needs. A-01…A-12, all accepted 2026-10-14. |
| [research/01-market/](research/01-market/) | Round 1: what Laravel sells, the JS/TS framework market, and an inventory of every `@arki/*` package. |
| [research/02-advisors/](research/02-advisors/) | Round 2: the same brief answered blind by two advisors (Fable and Astra), plus the synthesis and verified findings. |
| [research/03-plan/](research/03-plan/) | Round 3: top Laravel packages + Laravel AI, the JS AI market, Arki's AI inventory, and the two advisor plans merged into plan.md. |
| [research/04-effect/](research/04-effect/) | Round 4: why Effect is famous, a capability map of Effect vs `@arki`, two blind advisor answers, and a merged three-wave roadmap (synthesis.md) with decisions D-01…D-07. |
| [research/05-convex/](research/05-convex/) | Round 5: why Convex is famous, a 44-row capability map of Convex vs `@arki`, two blind advisor answers, and a merged ranked list of 13 lessons (synthesis.md) — live queries are the one hard gap. |
| [research/06-nestjs/](research/06-nestjs/) | Round 6: why NestJS is famous, its Sep–Oct 2026 first-party reliability/auth/observability wave, a capability map vs `@arki`, two blind advisor answers, 10 verified code findings, and a five-wave merged recommendation (synthesis.md) with decisions A–E. |
| [research/07-result/](research/07-result/) | Round 7: Result and typed-error libraries in TypeScript, PHP and other languages, and the founder's design and name choices for `@arki/failure`. |

## How to add to this area

- New research goes in a new numbered round: `research/03-{topic}/`, with a `README.md` stating the question, method, date, and caveats.
- When the founder decides something, update its row in `decisions.md` (status, date, reason). Then update `strategy.md` if the strategy changes.
- Do not edit old research rounds to match new conclusions. They are a record of what was known at the time.
