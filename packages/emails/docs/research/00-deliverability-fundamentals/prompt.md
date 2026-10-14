---
title: '@arki/emails — Outbound Deliverability Fundamentals (SES + Cloudflare ES)'
type: package-research-prompt
package: '@arki/emails'
slug: emails-deliv
round: 00
depends-on: ['apps/avocabo/docs/features/newsletter-ingestion/research/00-email-infrastructure-feasibility']
decision-to-unblock: 'Define the operational deliverability contract for every consumer app using @arki/emails. Output: a per-provider config + DNS recipe + monitoring + warmup playbook that an app can adopt to make inbox-placement reliable.'
bootstrap-constraints: inherit
status: ready
research-home-precedent: 'First instance of package-level research at packages/{name}/docs/research/. Founder-chosen 2026-05-29; treat as the canonical pattern for cross-cutting @arki/* infra research that informs every consumer app.'
tags:
  [
    research,
    package-research-prompt,
    deliverability,
    ses,
    cloudflare-email-service,
    spf,
    dkim,
    dmarc,
    bimi,
    mta-sts,
    tls-rpt,
  ]
---

## Package Context

- **Package:** `@arki/emails` at `packages/emails/`. Wraps multiple transactional-email providers behind a typed client (`initEmails`) and a `quotaRouter` that fails over by monthly quota.
- **Live providers in `packages/emails/src/providers/`:** `resend`, `unosend`, `ses` (AWS SES v2 — supports `configurationSetName`), `cloudflare-email-service` (Cloudflare beta API — runtime-Zod-validated response), `quota-router` (provider chain).
- **Quota-router chain currently default-ordered (per `client/auto.ts`):** `resend → unosend → ses → cloudflare-email-service`. Fail-open semantics on provider exhaustion or per-provider error.
- **Consumer apps (current and planned):** avocabo (newsletter digests, magic-link auth), novelette (parent-facing transactional + magic-link), evervest (email-only product), arki internal (magic-link via `templates/arki-magic-link`). Each app sends from its own subdomain (`mail.{app}.{tld}` pattern envisaged but not enforced).
- **What `@arki/emails` does NOT do today:** does not manage DNS records, does not subscribe to bounce/complaint webhooks, does not check sender reputation, does not enforce a sending schedule for warmup, does not enforce `List-Unsubscribe` headers. These responsibilities sit at the app boundary or are not yet implemented anywhere.

## Research Goal

For every app that uses `@arki/emails`, define a **complete operational deliverability contract** that takes "we configured the provider" to "mail consistently lands in the inbox, not the spam folder, not the Promotions tab." Specifically for the **SES** and **Cloudflare Email Service** outbound paths (the two paths where we own more of the deliverability stack), plus the sending-domain authentication layer (SPF, DKIM, DMARC, BIMI, MTA-STS, TLS-RPT) that applies regardless of provider.

This is a **Type 3 (Pragmatic 90% Solution) + Type 5 (Cost, Latency, Operations) round.** The output must be implementation-ready: DNS record templates, config knobs the package should expose, a monitoring dashboard surface, a warmup schedule, and a tripwire/recovery playbook. NOT a survey of "what is DKIM."

**Critical framing constraint:** "100% deliverability" is a fiction in transactional email — even Gmail-to-Gmail has a non-zero spam rate. Reframe the goal as: **what is the realistic ceiling for our setup, and what are the highest-leverage interventions to reach it?** A serious answer will name a target inbox-placement-rate (IPR) range with sources, not pretend 100% is achievable.

## Scope

### In Scope

**Sending-domain authentication layer (provider-agnostic):**

- **SPF**: record syntax, lookup-count limits (RFC 7208 §4.6.4 — 10 DNS lookups max), `include:` strategy when combining providers (e.g., `_spf.resend.com` + `amazonses.com` + `_spf.mcsv.net`), softfail vs fail (`~all` vs `-all`), the SPF-and-forwarding problem (SRS, ARC).
- **DKIM**: 2048-bit recommendation, key rotation cadence, per-provider selector naming, the "multiple selectors for multi-provider sends" pattern (do Gmail/Outlook accept any-of, or require all-of?), DKIM ed25519 (RFC 8463) — viable yet?
- **DMARC**: `p=none → p=quarantine → p=reject` progression, `sp=` subdomain policy, `pct=` rollout, `rua=` / `ruf=` aggregate-report endpoints (recommended SaaS: Postmark DMARC Digests, dmarcian, EasyDMARC, Valimail — pricing 2026, what they actually report), DMARC alignment (`aspf=`, `adkim=` strict vs relaxed), the BIMI prerequisite (`p=quarantine` minimum + `pct=100`).
- **BIMI**: requirements (VMC from Entrust / DigiCert / VerifiedMark — cost in 2026), Gmail/Yahoo/Apple Mail support matrix, CMC (Common Mark Certificate) as the cheaper alternative for unregistered marks (Gmail's 2024 pilot — production-ready now?), the SVG-Tiny-PS spec, what happens when BIMI fails silently.
- **MTA-STS & TLS-RPT** (RFCs 8461 / 8460): is this worth the operational cost for a solo bootstrapper sending transactional mail? Recommended config. Hosting the policy file on a static HTTPS endpoint (CDN vs Cloudflare Worker). TLS-RPT report endpoints (Postmark? Self-hosted parser?).
- **Return-Path / bounce domain alignment**: SES sets `mail-from:` to a SES-owned domain by default unless a custom MAIL FROM is configured; what's the deliverability impact? Cloudflare ES — what does the bounce-from look like and is it configurable?
- **DNS hygiene**: PTR / reverse DNS (does this apply when sending through a managed provider? Some sources say "no, the provider owns the sending IPs"; others claim PTR alignment on the HELO/EHLO domain still matters — resolve this).

**SES-specific (shared IP, dedicated IP, Configuration Sets):**

- **Sandbox-to-production transition**: 200/day sandbox limit; the actual review process in 2026 (form fields, response time, common rejection reasons, what to do when rejected); whether sending volume requested affects approval.
- **Shared IP pool reputation** (the SES default): what is the realistic IPR for shared-pool SES into Gmail/Outlook in 2026? Are there known bad-neighbor incidents? When does it make sense to graduate to dedicated IP?
- **Dedicated IP economics and warmup**: $24.95/mo per dedicated IP — when is the breakeven? AWS's auto-warmup ramp schedule (45 days, max 50K/day end state); what happens if you exceed the ramp; SES Virtual Deliverability Manager (VDM) and "Guided" warmup.
- **Dedicated IP Pools**: routing transactional vs marketing through separate IPs from the same account; how Configuration Sets do this; whether `@arki/emails` should expose a `pool` parameter.
- **Configuration Sets** (which the `ses` provider already accepts via `configurationSetName`): what they actually control — IP pool routing, reputation tracking, event publishing (Delivery, Bounce, Complaint, OpenClick, Reject); recommended default Configuration Set for a new app; SNS topic vs EventBridge vs Firehose for event delivery.
- **Bounce / complaint suppression flow**: SES does NOT auto-suppress on a per-account basis by default for soft bounces; the SES account-level suppression list vs per-Configuration-Set suppression; how to consume bounce/complaint SNS notifications and write them into a domain-level suppression table; the 3-bounce-rule, the 0.1% complaint rate threshold, the 5% bounce rate threshold that triggers AWS review.
- **AWS Sender Reputation dashboard**: what it actually shows, what triggers an account review, the playbook when reputation slips.

**Cloudflare Email Service-specific (beta as of 2026-05):**

- **Production maturity audit**: what is the current beta-graduation timeline (any 2026 GA announcements)? What is the documented uptime / SLA / reliability track record? Are there known incidents?
- **Sending IPs and reputation**: shared pool with whom? Does Cloudflare offer dedicated IPs, IP pools, or sender-isolation? How does CF ES deliverability compare to SES shared-pool to Gmail / Outlook / Apple Mail in 2026? Independent test results (Mailgun-style, GlockApps, Email-on-Acid) preferred.
- **Auth records required**: the exact DNS records CF ES needs (SPF include, DKIM selector pattern, MAIL FROM / return-path domain), how it handles DMARC alignment, whether it supports custom `From` domains.
- **Bounce / complaint signal**: the API response shape (`delivered: string[]`, `permanent_bounces: string[]`, `queued: string[]` — we already validate this with Zod) — does CF expose async bounce/complaint webhooks? If not, how do we detect a deliverability problem after the API returns 200?
- **Rate limits and the 3k-free / $0.35-per-1k tier**: practical send-rate ceiling per second; Cloudflare Workers Paid prerequisite ($5/mo); pricing snapshot 2026.
- **Feature gaps vs SES**: no Configuration Sets analog; no dedicated IPs documented; no native VDM-style reputation dashboard; what does CF expose instead? A risk register of "we lose visibility X by choosing CF over SES" line items.

**Content & header layer (provider-agnostic but content-shaped):**

- **`List-Unsubscribe` (RFC 2369) + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058)**: Gmail and Yahoo enforced this for bulk senders as of Feb 2024. Mandatory for any sender > 5000/day. How to wire it through `@arki/emails` for digests and not-for transactional auth mail; the unsubscribe endpoint contract (HTTPS, idempotent, no auth required).
- **Yahoo / Gmail 2024 bulk-sender rules** (5000+/day): 0.3% spam-rate ceiling, one-click unsubscribe within 2 days, DMARC enforcement. What @arki/emails consumers need to know.
- **Header hygiene**: `Reply-To`, `Message-ID`, `Date`, `In-Reply-To` / `References` for threading, `Auto-Submitted` (RFC 3834), `Precedence: bulk` vs nothing for digests.
- **Content tripwires**: link-to-text ratio, image-only emails, URL shorteners (bit.ly etc. as automatic spam markers), tracking-pixel patterns, sender-name vs `From` mismatch, subject-line patterns (all-caps, emoji density, "Free", "$$$"), Apple Mail Privacy Protection's prefetch-everything behavior breaking open-rate.
- **Plain-text alternative**: how much it actually moves the needle in 2026 (some sources say "trivial"; others "load-bearing for Gmail Promotions detection").
- **Gmail clipping at 102KB** (the digest constraint specifically): measurement methodology, the chunking strategy (multi-part digests vs link-to-web), how Apple Mail / Outlook handle the same size.

**Monitoring & feedback loop layer:**

- **Postmaster signals**: Gmail Postmaster Tools (domain reputation, IP reputation, spam rate, feedback loop), Microsoft SNDS + JMRP, Yahoo CFL, Apple iCloud feedback (does this exist in 2026?). Setup walkthrough per app; what metrics to alert on; recommended sampling cadence.
- **Third-party deliverability monitors**: GlockApps, Mailgun's email validator, Litmus Spam Tests, MXToolbox blacklist monitor — 2026 pricing snapshot, what each adds beyond Postmaster.
- **DMARC aggregate-report consumers**: comparison Postmark vs dmarcian vs EasyDMARC vs Valimail in 2026 — pricing, ease of setup, what the dashboard actually shows, RUF (forensic report) support and whether RUF is worth it given GDPR concerns.
- **Sender reputation feedback into `@arki/emails`**: should the `quotaRouter` consider provider reputation, not just quota? E.g., if SES bounce rate exceeds 3%, automatically demote SES below Cloudflare in the chain. What signals would we need from the providers to do this?

**Warmup playbook:**

- **New-sending-domain warmup**: realistic day-by-day volume curve for weeks 1-8 (cite: Mailgun warmup guide, Litmus, Postmark, Resend's docs). Same domain → SES shared IP differs from same domain → CF ES — does the warmup actually transfer when adding a new provider for the same domain?
- **Domain age vs IP age**: which matters more in 2026? Is buying an aged domain a deliverability cheat-code, or does Gmail's reputation system look at content + auth alignment more than domain age?
- **Cold start failure modes**: what happens to the first 100 messages from a brand-new domain via SES sandbox vs Cloudflare ES? Specific Gmail / Outlook / Apple Mail behaviors.

### Out of Scope

- **Inbound** email (covered by avocabo round 00 — `D-F-NI-01` Cloudflare Email Workers decision).
- **Provider selection / multi-provider chain ordering**: round 00 of avocabo already locked the chain order; this round assumes that chain and focuses on making each provider deliver well.
- **Resend / Unosend deep dive**: those are providers we use, but they're managed services with relatively low ops surface; this round narrows to the two providers where we own more of the deliverability stack (SES, CF ES). A follow-up round can do the head-to-head at warmup-month-2.
- **Email template design / content quality** beyond the deliverability-impact dimension (subject-line patterns, link density). Template aesthetics are a separate concern.
- **OAuth / Gmail API send** — none of our use cases send via Gmail API.
- **MTA self-hosting** (Postal, Haraka, Maddy): conclusively rejected in avocabo round 00 (`B-NI-00-01`).
- **The `@arki/auth` magic-link template specifically**: covered as a special case only where transactional-mail rules diverge from bulk-mail rules (e.g., List-Unsubscribe not required for one-to-one auth mail).

## Key Questions

### Q1 — Sending-domain authentication: what is the minimum-viable record set, and what is the production-grade record set?

- For each of **SPF, DKIM, DMARC, BIMI, MTA-STS, TLS-RPT**: state the minimum-viable record (what every consumer app should ship from day 1) AND the production-grade record (what we need at scale or for BIMI logo). Give concrete record values, not just "set up DKIM."
- For **SPF**: walk through the 10-DNS-lookup constraint. With Resend + Unosend + SES + Cloudflare ES all sending from the same root domain, do we exceed 10 lookups? If so: subdomain-per-provider strategy vs SPF flattening services (e.g., EasySPF, Scott Helme's SPF Record Generator) — name vendors, 2026 pricing.
- For **DKIM**: when multiple providers each set their own DKIM selector on the same domain, do receivers require all-of or any-of for DMARC alignment? Sources cited, not speculation.
- For **DMARC**: realistic timeline `p=none → p=quarantine → p=reject` for a brand-new domain. What is the data signal that says "ready to advance"? Recommend a default `pct=` rollout schedule.
- For **BIMI** in 2026: is it worth the VMC cost ($1,500-$3,000/year per source) for a bootstrap product? Has CMC (Common Mark Certificate, $1,000/year per 2024 Gmail pilot) graduated to general availability?
- For **MTA-STS + TLS-RPT**: do we need them for transactional mail to Gmail/Outlook recipients? What's the deliverability lift vs the setup cost?
- For the **SES MAIL FROM** alignment issue and the **Cloudflare ES bounce-from** behavior: what's actually shipped, and what config knob do we need?

### Q2 — SES configuration & operations: what is the production-readiness checklist?

- The **sandbox-to-production submission**: 2026 form-field walkthrough, expected approval time, common rejection patterns, what to write in the use-case field.
- **Configuration Sets**: the recommended default config set for a new `@arki/emails` consumer app. Should we expose Configuration Set fields beyond just `configurationSetName` (e.g., per-pool routing, event-publishing destination)?
- **Bounce / complaint pipeline**: SNS-topic-per-event-type vs single-topic-multi-event; suppression-list mechanics (account-level vs Configuration-Set-level vs domain-managed); the ingestion pattern a consumer app should follow (Lambda → Postgres? SQS → app worker? `@arki/queue` integration?).
- **Shared-IP vs dedicated-IP economics in 2026**: at what monthly send volume does dedicated IP ($24.95/mo) become worthwhile? What is the warmup cost (lost deliverability during the 45-day ramp)?
- **VDM (Virtual Deliverability Manager)**: is it worth $0.10/1k surcharge for the auto-warmup + reputation dashboard, or can we replicate it with our own monitoring?
- **AWS sender review trigger**: 5% bounce / 0.1% complaint thresholds — the playbook when the email arrives "your account is under review."

### Q3 — Cloudflare Email Service in 2026: production-ready yet, and what's the visibility gap?

- **GA status check**: as of the research date, is CF ES still in beta? If GA, when? What changed between beta and GA?
- **Inbox-placement empirical data**: any independent (GlockApps, Litmus, Mailgun-style) deliverability tests of CF ES into Gmail / Outlook / Apple Mail in 2026? If none exist, name 1-2 sources that have tested adjacent CF email products (Email Routing, Email Workers outbound, Pages mailing).
- **IP reputation isolation**: shared pool with what cohort? Does CF expose dedicated IP or IP pool isolation? If a Cloudflare neighbor goes spammy, what's our exposure?
- **Bounce / complaint async signals**: the API returns `permanent_bounces` synchronously, but how do we get notified of soft bounces and abuse complaints that arrive minutes-to-days later? Webhook? Polling? Email-only? If no async signal exists, name the workaround.
- **DMARC alignment quirks**: does CF ES support custom MAIL FROM / return-path, or are we forced into a CF-owned bounce domain that breaks strict DMARC alignment?
- **Feature gaps vs SES** — risk register: what visibility / control do we lose by routing through CF ES instead of SES? The honest answer.

### Q4 — Bulk-sender rules (Gmail/Yahoo Feb 2024+) and the digest-specific operational floor

- **The 5000/day threshold**: at what user count does avocabo / evervest cross this? Recommended cushion before crossing (e.g., comply with bulk rules at 3000/day to avoid the cliff).
- **List-Unsubscribe + One-Click (RFC 8058)**: implementation contract for `@arki/emails` consumers; the HTTP endpoint shape; storing unsubscribe state per-recipient per-stream (transactional vs marketing); what counts as "bulk" for the auth-magic-link case (probably nothing — but is "weekly summary" bulk?).
- **0.3% spam rate (Gmail Postmaster)**: what triggers it, what the recovery curve looks like once you've tripped it, the relationship between spam rate and Promotions-tab placement.
- **Subject-line / sender-name / preheader patterns** that empirically tank deliverability in 2026 across Gmail / Outlook / Apple Mail.
- **Tracking pixels and click-tracking redirects**: do they hurt deliverability enough to remove them entirely? The "Apple Mail Privacy Protection prefetches everything, breaking open-rate metrics, so remove pixels" school of thought — is it correct in 2026?
- **Gmail Promotions tab vs Primary**: what content signals push a transactional email into Promotions even when auth passes? Specifically the digest case.

### Q5 — Monitoring, alerting, and recovery playbook

- **Postmaster setup walkthrough**: Gmail Postmaster Tools (domain + IP registration), Microsoft SNDS + JMRP enrollment, Yahoo CFL, Apple Mail feedback (if it exists). What the actual onboarding takes for each.
- **The minimum dashboard**: what 5-10 metrics should every `@arki/emails` consumer app track per provider per day? Where should this data land — `@arki/meter`? Plausible custom events? A dedicated Grafana board?
- **Tripwire thresholds**: bounce rate > X → page; complaint rate > Y → demote provider in quota-router; spam rate (per Postmaster) > Z → halt sending to investigate. Recommend specific numbers, not "monitor closely."
- **Recovery playbook when reputation slips**: step-by-step what to do (cool down, segment audience, re-warm, switch providers, file IP-reputation appeal with the relevant ISP).
- **Should `@arki/emails` expose a reputation-aware router?** I.e., extend `quotaRouter` to consider per-provider reputation signals, not just quota. Sketch the contract — what signals would the package need from each provider, and which providers actually expose them?

### Q6 — The realistic ceiling

- **What is a defensible target inbox-placement-rate (IPR)** for our setup (SES shared IP + CF ES + aligned auth + RFC 8058 unsubscribe) sending to Gmail / Outlook / Apple Mail in 2026? Cite at least 2 industry benchmarks (Litmus State of Email Deliverability, ReturnPath/Validity sender benchmarks, Mailgun, Postmark transparency reports).
- **What is the marginal IPR improvement from each intervention?** Rank the interventions: DKIM 2048 → +X%, DMARC `p=reject` → +Y%, BIMI → +Z%, dedicated IP → +W%. This is the "where do I spend my next engineering hour" question.
- **At what point is "100% deliverability" mathematically impossible** even with everything done right? Honest answer with sources.

## Disconfirming Evidence to Hunt

- **"The provider handles deliverability for you."** Cloudflare ES and SES both market this; find evidence of bootstrapped products that did exactly what the provider told them and still ended up in Gmail Promotions or Outlook Junk. If 80% of well-configured senders see >90% IPR but the failure-mode tail is brutal, we need to know.
- **"SES shared IP is fine for transactional."** Find recent (2025-2026) developer reports of SES shared-IP deliverability issues with Gmail / Outlook for transactional traffic. Counter-evidence: AWS's own claim that shared pools are reputation-protected.
- **"Cloudflare ES is production-ready."** It's in beta as of 2026-05. Find evidence of any production app sending non-trivial volume through CF ES in 2026 — or evidence that even the early adopters report disqualifying issues.
- **"BIMI moves the needle."** Find independent A/B-test evidence of BIMI's impact on open rates or trust signals. Vendor case studies don't count. If the lift is < 5%, BIMI is not worth $1.5-3k/year for a bootstrap.
- **"MTA-STS is essential."** Find evidence one way or the other. Resend, Postmark, and the Gmail SecOps blog say "highly recommended"; many production senders skip it entirely.
- **"DMARC `p=reject` causes legitimate mail to bounce."** The fear that aggressive DMARC will cause auth-via-forwarder to fail (mailing lists, alumni forwarders, ARC-broken forwarders). Quantify the actual failure rate observed by senders who went to `p=reject`.
- **"Unsubscribe-list-id headers actually help inbox placement."** Or are they just a compliance checkbox? Sources cited.
- **"You need a dedicated IP to compete."** Or is this provider upsell? Find senders at 100k-1M/month who stayed on shared IP with great deliverability.

## Implementation-Specific Deliverables

The brief should return a structured document that an engineer can implement from. Required artifacts:

1. **DNS Record Cookbook** — copy-pasteable BIND/Cloudflare-zone records for SPF, DKIM (one selector per provider), DMARC (with `p=none → quarantine → reject` rollout schedule), BIMI (when applicable), MTA-STS policy file, TLS-RPT endpoint, MX (for bounce-from if applicable). One table per provider.

2. **`@arki/emails` API surface deltas** — what config knobs the package should expose that it doesn't today. E.g., should `sesProvider({ ... })` accept a `pool` parameter? Should there be a top-level `deliverabilityHeaders({ listUnsubscribe, listId, precedence })` helper? Concrete proposals tied to specific files in `packages/emails/src/`.

3. **SES Configuration Set template** — recommended fields, event-destination wiring, IP-pool config, SNS topic naming convention.

4. **Bounce / complaint webhook contract** — the API surface that a consumer app needs to receive bounce/complaint events from SES (and from CF ES if it has one). Suppression-list schema sketch.

5. **Warmup schedule** — day-by-day send-volume curve for weeks 1-8 of a new sending domain, for both SES (shared IP and dedicated) and Cloudflare ES. State the threshold per day, the escalation rules, and the abort criteria.

6. **Monitoring dashboard spec** — the 5-10 metrics per provider per day, where they should be stored, and the recommended alert thresholds.

7. **Recovery playbook** — flowchart: spam-rate spike → triage → mitigation → recovery. Includes provider-rotation via `quotaRouter`, ISP appeal contacts, audience segmentation.

8. **Risk register** — top 8-10 deliverability risks ranked by likelihood × impact, with the mitigation for each.

9. **Target-IPR statement** — defensible % range per ISP cohort, citing benchmarks. Plus the "honest impossible-to-improve" floor.

10. **Phased adoption plan** — what to ship in week 1 (DNS records + transactional only), what to ship before crossing 5000/day (bulk-sender compliance + List-Unsubscribe + Postmaster monitoring), what to ship at >100k/month (dedicated IP, VDM, advanced monitoring).

## Standards

1. **Option-shaped findings, not recommendations.** Per `.agents/harness.md` "Research is information; founder decides," every key decision (e.g., `p=reject` vs `p=quarantine` long-term, BIMI yes/no, dedicated IP at what volume) must be returned as **2-4 alternatives with trade-offs**, not a single answer. The founder picks; the research surfaces the option space with evidence per option.
2. **Preserve dissenting voices.** When sources disagree (e.g., "MTA-STS is essential" vs "MTA-STS is theater"), include both with their evidence basis. Do not collapse to consensus.
3. **Cite URLs and dates accessed.** Especially for vendor pricing and policy claims — both change frequently. Pricing must be from the vendor's own pricing page, with date of access, not from a comparison blog.
4. **Quantify, don't qualify.** "Improves deliverability" is worthless; "+12% IPR at Gmail per Litmus 2024 study (URL)" is useful.
5. **Honest disclaimer when evidence is thin.** If "CF ES production track record" has no public data, say so explicitly — do not paper over with vendor marketing.
6. **No vendor marketing as evidence.** A Cloudflare blog post claiming high deliverability is a claim, not evidence. Independent test results (GlockApps, Litmus, Mailgun, third-party Postmaster data shared by senders) are evidence.

### Topic-Specific Rules

1. **"Just set up SPF/DKIM/DMARC" without specifics is not a finding.** Each record needs syntax, value, and trade-off discussion. If the engine returns "configure DMARC properly," it has failed.
2. **"Configuration Sets" must include the SNS event-publishing pattern with concrete event types.** "Configure event publishing" is too vague; "publish Bounce + Complaint to an SNS topic, route to an SQS queue, consume in a Lambda or `@arki/queue` worker that writes into a `email_suppressions` table" is useful.
3. **Bulk-sender rule research must reflect actual 2024+ enforcement experience**, not the 2024 announcement text. What did senders actually observe Gmail/Yahoo doing in Q3/Q4 2024 and 2025-2026?
4. **`@arki/emails` API proposals must reference specific files** in `packages/emails/src/` and respect the existing typed shape (`EmailProvider`, `SendEmailPayload`, `quotaRouter`).

### Prior Context

The brief inherits from `apps/avocabo/docs/features/newsletter-ingestion/research/00-email-infrastructure-feasibility/findings.md` (digested 2026-05-28). Specifically relevant findings that the engines should NOT re-litigate:

- `B-NI-00-01` — self-hosted MTA non-viable on Hetzner. Do not propose Postal/Haraka.
- `B-NI-00-02` — SendGrid Inbound Parse silent-drop. Do not propose SendGrid for outbound either.
- `B-NI-00-05` — cost model at 1K users $29-$81/mo on managed stack. Use this as the cost baseline; don't re-derive.
- `B-NI-00-06` — new-domain outbound warming = 2-6 weeks. This is the warmup baseline; refine, don't restart.
- `D-F-NI-02` — outbound stays on `@arki/emails` quotaRouter; expand providers. The chain is decided; this round is about making each provider in the chain deliver well, not re-choosing.

Source files referenced by this prompt:

- `packages/emails/src/providers/ses.ts` (the live SES provider — supports `configurationSetName`)
- `packages/emails/src/providers/cloudflare-email-service.ts` (the live CF ES provider — Zod-validated)
- `packages/emails/src/providers/quota-router.ts` (chain composition)
- `packages/emails/src/client/auto.ts` (default chain + quota constants)
- `packages/emails/src/index.ts` (current public API surface)
