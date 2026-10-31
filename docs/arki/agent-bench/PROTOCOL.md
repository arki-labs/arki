# Agent Benchmark Protocol (preregistration)

Protocol ID: `AB-PROTO-1`. Plan row: W1-13. Source: `docs/arki/plan.md` § 6.
Status: DRAFT until committed. After commit it is frozen (see § 12).
Published later as `arki-labs/agent-bench`. This file is its first file.

## 1. Purpose and claim

We test one claim. Can an AI coding agent finish typical SaaS tasks on the Arki stack as well as on two common stacks, and for less money?

The claim we may publish ("Arki is better for agents") needs ALL of these:

| Id | Condition |
| --- | --- |
| AB-C1 | Task success on Arki is no worse than the best other stack. |
| AB-C2 | Zero critical security failures on Arki. |
| AB-C3 | Median cost per successful task on Arki is at least 15% lower than the best other stack, and the 95% interval supports it. |

If any condition fails, we publish anyway. We then drop the agent headline and lead with self-hosting, typed composition and upgrades (plan § 6, § 8).

## 2. Hypotheses (written before any run)

| Id | Hypothesis | Decided by |
| --- | --- | --- |
| AB-H1 | Pass rate on Arki is not lower than on T3 or Laravel. | § 8.1 |
| AB-H2 | Median cost per passing run on Arki is at least 15% lower. | § 8.2 |
| AB-H3 | Median time per passing run on Arki is not higher. | § 8.3 |
| AB-H4 | Arki has zero critical security failures. | § 8.4 |

H1 and H4 are non-inferiority checks. H2 and H3 are superiority checks. We expect nothing about individual tasks. Task-level results are reported, not tested.

## 3. Arms (stacks)

| Id | Stack | Exact starting point | Agent context files allowed |
| --- | --- | --- | --- |
| AB-S1 | Arki | `dot new` from `@arki/dot` 0.6.0 (plan § 6). See note A. | `AGENTS.md` shipped by the template |
| AB-S2 | T3 | `create-t3-app` with Drizzle + Postgres + Auth.js. Integrations declared in the task text (Stripe, queue, AI SDK). Version recorded in `locks/s2.json` at freeze. | none unless the template ships one |
| AB-S3 | Laravel | Laravel 13 React starter kit + Laravel Boost + Laravel AI SDK. Version recorded in `locks/s3.json` at freeze. | Boost guidelines |

Note A. Plan § 6 says 0.6.0. The work order for this file said 0.5.0, and `packages/dot/package.json` says 0.5.0 today. The pin is 0.6.0. If 0.6.0 is not on npm at freeze time, the freeze commit must say which version replaced it. That is a pre-freeze fix, not an amendment.

Each arm ships its own lockfile, Docker image digest and tool versions in `locks/`. Each stack may use its own context files. Nothing else is stack-specific.

## 4. Agents and models

Plan § 6 fixes two agents with ONE pinned model each. Pins are exact IDs, not aliases.

| Id | Harness | Model ID | Verification | Pinned on |
| --- | --- | --- | --- | --- |
| AB-A1 | Claude Code (version recorded in `locks/`) | `claude-sonnet-5-5` | Verified: the model ID of the session that wrote this file. | 2026-10-14 |
| AB-A2 | Codex CLI 0.161.0 | `gpt-6.1-sol` | Read from the local Codex config (`~/.codex/config.toml`). NOT confirmed on a vendor page. Web search found only third-party pages naming `gpt-5.5` as default, which is unverified and likely stale. See open item O1. | 2026-10-14 |

Other models, for reference only. They are NOT in the 180-run sample.

| Model | ID | Verification |
| --- | --- | --- |
| Claude Opus | `claude-opus-5-5` | Given by the founder. Not re-checked online. |
| Claude Haiku | `claude-haiku-5-5` | Given by the founder. Not re-checked online. |
| Local Ollama | `qwen3.6:latest` (digest `07d35212591f`) | Present on the benchmark host (`ollama list`). Vendor page unverified. Third-party roundup: https://www.morphllm.com/best-ollama-models |

Settings (reasoning effort, temperature, tool list, permission mode) are recorded in `locks/agents.json` at freeze. They are identical across stacks for the same agent.

Open item O1: before freeze, confirm `gpt-6.1-sol` on an OpenAI page and paste the URL here. If it cannot be confirmed, mark AB-A2 "unverified" in the freeze commit and publish that label.

## 5. Tasks

All tasks use identical wording on every stack (§ 9). Each has a pass check written BEFORE any run. Checks are black-box: HTTP calls, database reads and test commands against the running app. They do not read agent code.

| Id | Task | Start state | Pass check (runnable) |
| --- | --- | --- | --- |
| AB-T01 | Scaffold the app and deploy it to the benchmark container host. | Empty directory plus the stack's generator. | `check/t01.sh`: container starts, `/health` returns 200, a user can sign up and log in, data survives restart. |
| AB-T02 | Tenant-scoped CRUD: a "notes" resource with a migration and a list page. | Fresh T01 reference app. | `check/t02.sh`: create, read, update, delete over HTTP as user A. User B in another tenant gets 403 or 404 on A's rows. List page shows only own rows. Migration applies on an empty database. |
| AB-T03 | Durable background job with retry and an hourly schedule. | Fresh T02 reference app. | `check/t03.sh`: job runs after enqueue. Forced failure retries and then succeeds. Job survives an app restart. Schedule entry exists and fires hourly (time faked by the harness clock). |
| AB-T04 | Subscription webhook changes entitlement state. | Fresh T02 reference app. Stripe test-mode fixtures provided. | `check/t04.sh`: signed `checkout.completed` event upgrades the tenant. Bad signature is rejected. Replayed event is idempotent. Cancel event downgrades. |
| AB-T05 | AI tool with approval and quota. | Fresh T02 reference app. Mock model server provided by the harness. | `check/t05.sh`: the tool call waits for approval. Denied means no side effect. Approved means one side effect. Calls over the quota are refused. |
| AB-T06 | Upgrade a dependency from a seeded older version. | Fresh T02 reference app pinned to an older stack version (`seed/<stack>-old`). | `check/t06.sh`: app builds on the new version, T02 check still passes, lockfile shows the target version. |

"Fresh Tnn reference app" means a clean snapshot for each stack, built by the harness team and stored under `seed/`. The snapshot is the same size of work on each stack. Each stack's snapshot is reviewed by someone who did not write it. Seeds are frozen with this file.

Security checks run on every task in addition to the pass check (§ 7.4).

## 6. Design, budgets, repetitions

| Item | Value |
| --- | --- |
| Cells | 6 tasks x 3 stacks x 2 agents = 36 |
| Repeats per cell | 5 |
| Total runs | 180 (W6-05). Calibration batch (W5-06) is separate and excluded. |
| Order | Fully randomised. Seed in `locks/order-seed.txt`, chosen by `date +%s` at freeze and written down before any run. |
| Model sampling | Vendor defaults for the pinned settings. No per-run seed is available for most agents. We do not claim runs are reproducible, only that the protocol is. |
| Wall time cap | 45 minutes per run |
| Cost cap | $5 inference per run, from measured tokens x published price list pinned in `locks/prices.json` |
| Token cap | Bound by the cost cap. Input, output and cache tokens are all recorded. |
| Tool-call cap | 400 per run |
| Retries | The agent may retry freely inside the caps. The harness never retries a run. An infrastructure failure (§ 8.5) may be rerun once from a clean reset. |
| Human feedback | Same fixed script on every run. The only human message is the scripted reply to a blocking question: "Use your best judgement." Each such reply counts as one intervention. |
| Hardware | Same host class and image for all runs. Clean reset (fresh container, database and cache) before each run. |
| Setup cost | Generator download and install time is recorded separately. It is not in task time or cost. |
| Total budget | Benchmark inference at most $900 (plan § 1). Stop and amend if the calibration batch projects above $900. |

Hitting a cap ends the run. The run scores as fail with cause `cap`.

## 7. Metrics

| Id | Metric | Definition |
| --- | --- | --- |
| 7.1 | Pass | Pass check exits 0 on the final state and no manual repair happened. Binary. |
| 7.2 | Cost | USD per run, from tokens and the pinned price list. Reported for all runs and for passing runs. |
| 7.3 | Time | Wall seconds from first prompt to the agent's stop. |
| 7.4 | Security failures | A critical failure is one of: cross-tenant data access, missing auth on a protected route, unsigned webhook accepted, secret committed or logged, SQL injection. Checked by `check/security.sh` plus independent adjudication. |
| 7.5 | Interventions | Count of scripted human replies (§ 6). A run with more than 3 scores fail with cause `intervention`. |
| 7.6 | Repair rounds | Count of times the agent reruns a failing test or command after a failure. Descriptive only. |
| 7.7 | Tokens | Input, output, cache read, cache write. |

Manual repair by a human never counts as agent success. If a human edits code, the run is `fail`.

## 8. Analysis plan

Rows are runs. Each run emits one JSON row to `results.json`, including failures.

### 8.1 Pass rate (H1, AB-C1)

Per stack, pooled over tasks and agents, and per task. Wilson 95% interval for each rate. Difference Arki minus best other stack, with a bootstrap 95% interval (10,000 resamples, runs resampled within cell, seed written in `locks/`). H1 holds if the lower bound of the difference is at least -10 percentage points. This margin is chosen now and is not changed after data.

### 8.2 Cost (H2, AB-C3)

Median cost per successful task: the median of cost over passing runs, per stack. Ratio Arki / best other stack, with a bootstrap 95% interval. H2 holds if the upper bound of the ratio is at most 0.85.

### 8.3 Time (H3)

Median wall time over passing runs. Same bootstrap ratio. H3 holds if the upper bound is at most 1.00.

### 8.4 Security (H4, AB-C2)

Count of critical failures on Arki. H4 holds only if the count is 0 across all 60 Arki runs.

### 8.5 Infrastructure failures, flaky runs, ties

| Case | Rule |
| --- | --- |
| Infra failure (host down, registry outage, mock server crash, price/API outage) | Labelled `infra`. Rerun once from a clean reset. Both rows kept. The rerun row is used for scoring. The adjudicator decides the label, not the agent or the stack owner. |
| Flaky pass check | Each pass check runs 3 times on the final state. Pass needs 3 of 3. A check that disagrees with itself on a known-good reference app is a harness bug. Fix before freeze only. |
| Agent crash or harness-side crash | `infra` if the harness caused it. Otherwise fail. |
| Ties on a metric | Reported as ties. They do not count as a win. The claim rule needs the explicit thresholds in § 1 and § 8. |
| Missing cells | A cell with fewer than 5 rows after reruns is reported as incomplete. It stays in the table. |
| Subgroups | Per-agent and per-task tables are descriptive. No hypothesis is tested on them. No multiple-comparison claims are made from them. |

### 8.6 Adjudication

One person who did not build the harness reads every failed run and every security flag, using redacted traces. They assign one cause: `task`, `security`, `cap`, `intervention`, `infra`. The reasons are published with the traces.

## 9. Fairness rules

1. Same task text, word for word, on every stack. Only the stack name and the file paths of the seed differ.
2. Same harness, same caps, same hardware, same feedback script.
3. No stack-specific hints in prompts. Stack context files are allowed only as shipped by the stack itself (§ 3).
4. Declared integrations (Stripe, queue, AI SDK, mock model) are given the same way to every arm.
5. Pass checks and seeds are written and frozen before the first run. Nobody tunes them after seeing results.
6. No tuning of prompts, templates, docs, `AGENTS.md`, or Arki packages to the tasks after freeze. Arki changes that ship for other reasons land after the run window, and the benchmark pins the older version.
7. Anti-gaming (absolute): never shape inputs, tasks, checks, seeds, prompts or scoring to favour Arki. Never drop, hide or reclassify a bad run to improve a number. A suspected gaming act is reported in the results page, not quietly fixed.
8. Competitor starters are set up by following their own official docs, not by a custom setup that makes them worse.
9. Every failed run is published, with cost.

## 10. Reproducibility and publication

Public `arki-labs/agent-bench` holds: this file, harness, lockfiles, prompts, seeds, pass checks, raw redacted traces, failures, final diffs, `results.json`, and the script that regenerates every table. Every marketing claim links to one metric row. Limits are listed in the results page: two agents, one model each, six tasks, one host class, no seed control.

## 11. Immutable IDs

These IDs never change meaning and are never reused.

| Kind | IDs |
| --- | --- |
| Protocol | `AB-PROTO-1` |
| Tasks | `AB-T01` to `AB-T06` |
| Stacks | `AB-S1` (Arki), `AB-S2` (T3), `AB-S3` (Laravel) |
| Agents | `AB-A1` (Claude Code + `claude-sonnet-5-5`), `AB-A2` (Codex CLI + `gpt-6.1-sol`) |
| Claims | `AB-C1`, `AB-C2`, `AB-C3` |
| Hypotheses | `AB-H1` to `AB-H4` |
| Run ID | `AB-<task>-<stack>-<agent>-r<1..5>`, for example `AB-T03-S2-A1-r4` |

## 12. Change policy

1. This file is frozen when committed. The freeze commit hash is recorded in `locks/FREEZE`.
2. Existing text and IDs are never edited. Typo fixes that change no meaning are listed in the amendment log too.
3. Any change is a dated section below, with: date, what changed, why, and whether any run had started. Amendments after the first run cannot change tasks, checks, thresholds, caps or analysis in ways that affect results already seen. Such runs keep the old rule, and both results are published.
4. A replaced model or tool version gets a NEW ID (`AB-A3`, ...). It never overwrites `AB-A1` or `AB-A2`.
5. The W12 regression refresh reruns changed cells only. Original results stay visible (plan W12-02).

## Amendments

None.
