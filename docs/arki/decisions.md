# Arki — decisions

Each row starts as `proposed`. The founder sets it to `accepted` or `rejected`, with a date and a one-line reason. Source for every proposal: [strategy.md](strategy.md).

| ID | Decision | Status | Date | Reason / note |
| --- | --- | --- | --- | --- |
| A-01 | The free core is MIT and limited to about 20 supported packages. | accepted | 2026-10-14 | Both advisors agree. |
| A-02 | Never build hosting. Ship a Coolify deploy recipe instead. | accepted | 2026-10-14 | Both advisors agree. Hosting needs a team and capital. |
| A-03 | First paid product is an **annual** source licence (Solo ~$249–299/yr, Studio ~$999/yr), not a one-time kit. | accepted | 2026-10-14 | Astra's model. Fable proposed one-time $149/$299. Annual pays for upgrades; AdonisJS Plus validates it. |
| A-04 | Arki Console (flat-price hosted ops dashboard) is the second product, built only after 10 outside apps are connected. | accepted | 2026-10-14 | Fable's idea, with Astra's demand gate. |
| A-05 | The five-runtime + benchmark rule applies to leaf libraries only, not app-layer packages (queue, payments, auth, emails). | accepted | 2026-10-14 | Both advisors agree. Changes an existing workspace rule — needs explicit founder approval. |
| A-06 | Freeze new `@arki/*` packages for 6 months. | accepted | 2026-10-14 | Fable. |
| A-07 | Lead marketing with the agent angle, backed by a published, repeatable agent test vs T3 and Laravel + Boost. | accepted | 2026-10-14 | Fable rated high, Astra medium; the test settles it. |
| A-08 | Fix the § 8 blockers in strategy.md (stub verifier first) before any paid launch. | accepted | 2026-10-14 | Verified finding. Stub verifier fixed 2026-10-14: the old path now re-exports the real verifier. |
| A-09 | Adopt the four package tiers in [core-packages.md](core-packages.md): 19 Stack, 11 Libraries, 7 Licence candidates, the rest out of brand. | accepted | 2026-10-14 | Settles which packages are "the product". Three open questions listed in that file. |
| A-10 | The Stack's default design system is **workbench**. | accepted | 2026-10-14 | Founder choice. Neutral, tool-like; fits SaaS dashboards and operator screens. |
| A-11 | `@arki/queue` gains a Postgres-backed option next to BullMQ/Redis. | accepted | 2026-10-14 | Founder choice. Buyers run one less service. |
| A-12 | AI is a Stack pillar: every Arki app ships AI on the frontend and the backend. `@arki/ai` and `@arki/chat-ui` move from Licence candidates to the free Stack tier; `dot new` includes AI by default. Premium AI workflows may still live in the licence. | accepted | 2026-10-14 | Founder directive: "All apps need some AI on frontend and backend." Answers open question 3 in core-packages.md. |
| A-13 | Day-60 gate: pass mark **10** paying buyers, target 25. | accepted | 2026-10-14 | Challenge C1 (plan.md § 12). 25 by Dec 17 from zero audience is unlikely; a hard 25 would freeze Pro too early. |
| A-14 | First 5 pilot buyers pay **$149** for year one, normal Solo price after. | accepted | 2026-10-14 | Challenge C6. Discount traded for time and evidence. |
| A-15 | Replace "100 downloads a week from others" with: total npm downloads trend + outside issues/PRs + handshake-connected apps. | accepted | 2026-10-14 | Challenge C4. npm cannot separate own from outside downloads. |
| A-16 | Notifications ship as a recipe first; add an `@arki/emails/notifications` entry (mail + in-app rows on journal) once ≥ 3 buyers ask. | accepted | 2026-10-14 | Challenge C2. An entry, not a new package, so the freeze (A-06) holds. |
