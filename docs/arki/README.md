# Arki — commercial product

Arki is the `@arki/*` package set (about 54 packages under `packages/`) turned into a product people pay for. Laravel is the reference model: a free framework that feeds paid tools.

**Positioning (proposed):** *Arki is the maintained TypeScript SaaS foundation for people who ship many products on servers they control.*

**Status:** Research done 2026-10-14. Strategy proposed. No decision taken yet. See [decisions.md](decisions.md).

## Where things are

| File | What it holds |
| --- | --- |
| [strategy.md](strategy.md) | The recommended strategy: product, pricing, how to beat Laravel, risks, first 90 days. Start here. |
| [core-packages.md](core-packages.md) | Every `@arki/*` package sorted into four tiers: Stack, Libraries, Licence, Out of brand. |
| [decisions.md](decisions.md) | Decisions the strategy needs. Each one is `proposed` until the founder accepts or rejects it. |
| [research/01-market/](research/01-market/) | Round 1: what Laravel sells, the JS/TS framework market, and an inventory of every `@arki/*` package. |
| [research/02-advisors/](research/02-advisors/) | Round 2: the same brief answered blind by two advisors (Fable and Astra), plus the synthesis and verified findings. |

## How to add to this area

- New research goes in a new numbered round: `research/03-{topic}/`, with a `README.md` stating the question, method, date, and caveats.
- When the founder decides something, update its row in `decisions.md` (status, date, reason). Then update `strategy.md` if the strategy changes.
- Do not edit old research rounds to match new conclusions. They are a record of what was known at the time.
