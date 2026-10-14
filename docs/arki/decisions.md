# Arki — decisions

Each row starts as `proposed`. The founder sets it to `accepted` or `rejected`, with a date and a one-line reason. Source for every proposal: [strategy.md](strategy.md).

| ID | Decision | Status | Date | Reason / note |
| --- | --- | --- | --- | --- |
| A-01 | The free core is MIT and limited to about 20 supported packages. | proposed | 2026-10-14 | Both advisors agree. |
| A-02 | Never build hosting. Ship a Coolify deploy recipe instead. | proposed | 2026-10-14 | Both advisors agree. Hosting needs a team and capital. |
| A-03 | First paid product is an **annual** source licence (Solo ~$249–299/yr, Studio ~$999/yr), not a one-time kit. | proposed | 2026-10-14 | Astra's model. Fable proposed one-time $149/$299. Annual pays for upgrades; AdonisJS Plus validates it. |
| A-04 | Arki Console (flat-price hosted ops dashboard) is the second product, built only after 10 outside apps are connected. | proposed | 2026-10-14 | Fable's idea, with Astra's demand gate. |
| A-05 | The five-runtime + benchmark rule applies to leaf libraries only, not app-layer packages (queue, payments, auth, emails). | proposed | 2026-10-14 | Both advisors agree. Changes an existing workspace rule — needs explicit founder approval. |
| A-06 | Freeze new `@arki/*` packages for 6 months. | proposed | 2026-10-14 | Fable. |
| A-07 | Lead marketing with the agent angle, backed by a published, repeatable agent test vs T3 and Laravel + Boost. | proposed | 2026-10-14 | Fable rated high, Astra medium; the test settles it. |
| A-08 | Fix the § 8 blockers in strategy.md (stub verifier first) before any paid launch. | proposed | 2026-10-14 | Verified finding. Stub verifier fixed 2026-10-14: the old path now re-exports the real verifier. |
| A-09 | Adopt the four package tiers in [core-packages.md](core-packages.md): 19 Stack, 11 Libraries, 7 Licence candidates, the rest out of brand. | proposed | 2026-10-14 | Settles which packages are "the product". Three open questions listed in that file. |
| A-10 | The Stack's default design system is **workbench**. | accepted | 2026-10-14 | Founder choice. Neutral, tool-like; fits SaaS dashboards and operator screens. |
| A-11 | `@arki/queue` gains a Postgres-backed option next to BullMQ/Redis. | accepted | 2026-10-14 | Founder choice. Buyers run one less service. |
