---
name: arki-release
user-invocable: false
description: End-to-end release pipeline for the `@arki/*` npm scope and the `arki-labs/arki` public GitHub mirror. Use when the user mentions "ship arki", "publish @arki", "update the arki repo", "release a wave", "promote a package to public", or any release-tooling-related task. Encapsulates the full release doctrine (deterministic public tree → npm + GitHub mirror) and the 5-stage scorecard gate. Sub-procedures live alongside this file for deep dives (`ship-update.md`, `add-new-package.md`, `sync-github.md`, `troubleshooting.md`).
---

# arki-release

## When to invoke

- User says: "ship arki", "publish a new arki package", "promote @arki/X to public", "release Wave 2", "update arki-labs/arki", "I need to push the arki tree".
- User reports an issue specific to the `tooling/arki-release/` workspace or `.release/arki-public/` tree.
- A pending changeset entry exists in `.changeset/*.md` for an `@arki/*` package and the user wants to ship.
- The scorecard reports a state change that needs an operator decision.

Don't invoke for: general npm questions, generic monorepo work, or tasks that aren't about the `@arki/*` ecosystem.

## The five surfaces — keep them synchronized

```
┌───────────────────────────┐   bun release:arki   ┌────────────────────┐
│ Private monorepo source   │   export-public      │ Materialized tree  │
│ packages/<pkg>/*          │ ───────────────────► │ .release/arki-     │
│ + tooling/arki-release/   │                      │   public/          │
└──────────┬────────────────┘                      └────────┬───────────┘
           │                                                │
           │  scorecard reads source          ┌─────────────┼─────────────┐
           │                                  │             │             │
           ▼                                  ▼             ▼
   `bun release:arki                  ┌──────────────┐  ┌──────────────┐
    scorecard` (gate)                 │ npm registry │  │ arki-labs/   │
                                      │ @arki/*      │  │ arki on      │
                                      └──────┬───────┘  │ GitHub       │
                                             │          └──────────────┘
                                             │
                            bun release:arki │
                            sync-package-    │
                            repos            │
                                             ▼
                                      ┌──────────────────────────────────┐
                                      │ arki-labs/<name>                 │
                                      │ (per-package read-only mirrors;  │
                                      │  one commit per published        │
                                      │  npm version + v<x> tags;        │
                                      │  description prefixed            │
                                      │  `[Read-only mirror]`;           │
                                      │  Issues/Wiki disabled)           │
                                      └──────────────────────────────────┘
```

**Doctrine:** the **materialized tree at `.release/arki-public/`** is the canonical artifact. npm and `arki-labs/arki` are mirrors of it; the per-package repos at `arki-labs/<name>` are mirrors *of npm* (reconstructed from npm tarballs, one commit per published version). The materialized tree is **deterministically regenerated** from monorepo source — never hand-edit it. Per-package repos are **deterministically reconstructable** from npm — never hand-edit them either; the read-only signal is the `[Read-only mirror]` prefix on the repo description plus Issues/Wiki being disabled at create time.

## The release-doctrine non-negotiables

These come from `apps/arki/docs/plans/2026-05-20-arki-dot-public-release.md` and are encoded as scorecard checks:

- **No private leaks** — no personal names, emails, domains, private app names, internal monorepo docs.
- **No `workspace:*` / `catalog:`** — materializer must resolve every dep to a concrete semver.
- **Compiled artifacts** — every package ships `dist/*.js` + `dist/*.d.ts` (npm requires these).
- **README + LICENSE present** — every public package.
- **`publishConfig.access: public`** — every public manifest.
- **Scorecard gate OPEN** — `bun release:arki scorecard` must report `Stable release gate: OPEN` before any publish.

Run `bun release:arki scorecard` whenever in doubt. If `BLOCKED`, fix what's blocking before touching `npm publish` or `git push`.

## Versioning convention — 0.0.x while experimental

Decided 2026-05-21 by the founder: every `@arki/*` package ships under the **0.0.x experimental track** until the public API is stable enough to commit to semver guarantees. `1.0.0` is reserved for when "no breaking changes except in a major bump" is a credible promise — which we earn through the scorecard + adoption, not by fiat.

Below 1.0, a **breaking** change is a **minor** changeset (0.0.8 → 0.1.0), with every monorepo call site updated in the same slice and no compatibility shim. Any other change is a **patch** changeset. Never a major bump below 1.0. (Founder rule, restated 2026-10-14 in `docs/rfcs/2026-10-14-arki-structure.md` P8; it supersedes the earlier "patch for any change".)

## Top-level procedures — pick the right one

| Procedure | When to use | Sub-doc |
|---|---|---|
| **Ship update to existing wave package** (most common) | A package in a published wave changed; ship a new version. | [ship-update.md](./ship-update.md) |
| **Promote a private package to a public wave** | A new `@arki/*` package is ready for first publication. | [add-new-package.md](./add-new-package.md) |
| **Sync the GitHub monorepo mirror** | After any source change that should land on `arki-labs/arki`. | [sync-github.md](./sync-github.md) |
| **Sync the per-package mirrors** (`arki-labs/<name>`) | After any new npm publish, OR when `history` reports `missing` / `tag-drift` / `unarchived` on the mirror dimension. | [sync-package-repos.md](./sync-package-repos.md) |
| **Diagnose a release issue** | `npm publish` fails, scorecard blocks, fixture matrix breaks, etc. | [troubleshooting.md](./troubleshooting.md) |

## Hard rules

- **Apps and non-wave packages are NEVER versioned or released** (founder rule, 2026-07-04). Enforced structurally: `.changeset/config.json` sets `"privatePackages": { "version": false, "tag": false }`, and every workspace package outside the release waves carries `"private": true`. The pre-approved release set is therefore machine-checkable: `private: false` ⟺ listed in `arki.release.config.ts` waves. If `changeset version` ever bumps an `apps/**` manifest or a non-wave package, a `private: true` flag is missing — fix the flag and revert the bump; do not commit it. Promoting a package to public = flipping its flag via [add-new-package.md](./add-new-package.md), never ad hoc.
- **Never commit `.release/arki-public/`** — it's gitignored in the monorepo; the materializer regenerates it on demand.
- **Never run `git add -A` inside `.release/arki-public/` without confirming a local `.git/` exists there** — git walks UP to find a parent `.git` and will pollute the monorepo's index with sibling agents' work. See [troubleshooting.md](./troubleshooting.md#the-git-add-a-parent-walk-trap).
- **Force-push to `arki-labs/arki` is allowed** — the tree is deterministic. Just confirm with the user before destructive remote operations.
- **`npm publish` requires user OTP** — the agent **cannot** generate 2FA codes. Surface the manual loop and let the user run it. See [troubleshooting.md](./troubleshooting.md#the-npm-otp-wall).
- **Source manifests have `private: true` or `private: false`** — flipping that flag is gate-relevant. Only do it when promoting a package per [add-new-package.md](./add-new-package.md).
- **`arki.release.config.ts` is the source of truth for which packages are in which wave** — editing it changes scorecard candidate set immediately.

## Sanity-check incantations

```bash
# What's the release scorecard say right now?
bun tooling/arki-release/src/cli.ts scorecard | tail -20

# Compare source versions to what's on npm
for p in assert clock contracts date env log resilience string ts; do
  s=$(python3 -c "import json; print(json.load(open('packages/$p/package.json'))['version'])")
  n=$(npm view @arki/$p version 2>&1 | head -1)
  printf "%-25s source=%s  npm=%s\n" "@arki/$p" "$s" "$n"
done

# Is the materialized tree current?
bun tooling/arki-release/src/cli.ts export-public

# What's on the GitHub monorepo mirror?
git ls-remote git@github.com:arki-labs/arki.git

# Reconcile all five surfaces (source / npm / changelog / monorepo-mirror tags / per-package repos)
bun tooling/arki-release/src/cli.ts history

# Sync the per-package mirrors (dry-run shows the plan)
bun tooling/arki-release/src/cli.ts sync-package-repos --dry-run
```

## What this skill replaces

- The expectation that you remember the release flow from memory.
- The expectation that the doctrine lives only in the plan doc (which is long and getting stale).

This skill is the canonical, lived-experience version. When it drifts from `tooling/arki-release/src/*` or `arki.release.config.ts`, update the skill — those files are the implementation.

## Memory hooks for this session

- See `auto memory` for: project_arki_release_pipeline (procedures + commits map).
- See `auto memory` for: feedback_no_commit_without_review (commit discipline).
- See `auto memory` for: feedback_only_track_own_changes (sibling-agent isolation).
