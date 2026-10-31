---
name: arki-release
user-invocable: false
description: End-to-end release pipeline for the `@arki/*` npm scope, the per-package GitHub mirrors and the wave tags on `arki-labs/arki`. Use when the user mentions "ship arki", "publish @arki", "update the arki repo", "release a wave", "promote a package to public", or any release-tooling-related task. Encapsulates the full release doctrine (deterministic public tree → npm → per-package mirrors; wave tag on the source repo) and the 5-stage scorecard gate. Sub-procedures live alongside this file for deep dives (`ship-update.md`, `add-new-package.md`, `sync.md`, `troubleshooting.md`).
---

# arki-release

> **Changed 2026-10-30: this repo is `arki-labs/arki` itself.** It is the real
> source, not a generated mirror. A release never writes a commit here and never
> pushes `main`. `sync --prepare` only puts the annotated wave tag
> `v<wave>-<date>` on the candidate's source commit. `sync --apply` pushes that
> tag and creates the wave's GitHub Release. Push your own source changes with a
> plain `git push`, as usual.

## When to invoke

- User says: "ship arki", "publish a new arki package", "promote @arki/X to public", "release Wave 2", "update arki-labs/arki", "I need to push the arki tree".
- User reports an issue specific to the `tooling/arki-release/` workspace or `.release/arki-public/` tree.
- A pending changeset entry exists in `.changeset/*.md` for an `@arki/*` package and the user wants to ship.
- The scorecard reports a state change that needs an operator decision.

Don't invoke for: general npm questions, generic monorepo work, or tasks that aren't about the `@arki/*` ecosystem.

## The four surfaces — keep them synchronized

```
┌──────────────────────────────┐   bun release:arki   ┌────────────────────┐
│ Source: this repo,           │   export-public      │ Materialized tree  │
│ = arki-labs/arki on GitHub   │ ───────────────────► │ .release/arki-     │
│ packages/<pkg>/*             │                      │   public/          │
│ + tooling/arki-release/      │                      └────────┬───────────┘
└──────────┬───────────────────┘                               │ candidate
           │       ▲                                           │ tarballs
           │       │ wave tag v<wave>-<date>                   ▼
           │       │ + GitHub Release                   ┌──────────────┐
           │       │ (sync --apply; no commit,          │ npm registry │
           │       │  never pushes main)                │ @arki/*      │
           │       │                                    └──────┬───────┘
           ▼                                                   │ bun release:arki
   `bun release:arki                                           │ sync --apply
    scorecard` (gate)                                          ▼
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

**Doctrine:** this repo is the source and is `arki-labs/arki` on GitHub. The **materialized tree at `.release/arki-public/`** is what npm gets; it is **deterministically regenerated** from source — never hand-edit it. A release marks itself in this repo with one annotated wave tag on the candidate's source commit, plus a GitHub Release. It never commits a generated tree here and never pushes `main`. The per-package repos at `arki-labs/<name>` are mirrors *of npm* (reconstructed from npm tarballs, one commit per published version). They are **deterministically reconstructable** from npm — never hand-edit them; the read-only signal is the `[Read-only mirror]` prefix on the repo description plus Issues/Wiki being disabled at create time.

## The release-doctrine non-negotiables

These are encoded as scorecard dimensions; the tool enforces them, this list only names them:

- **No private leaks**, **no `workspace:*` / `catalog:`** in published manifests, **compiled `dist/`**, **README + LICENSE**, **`publishConfig.access: public`**.
- **Scorecard gate OPEN on the frozen candidate**, and **consumer smoke passes** on the same tarballs.
- **The bytes published are the bytes checked**: the founder publishes the candidate tarballs, never a fresh `npm publish <dir>`.

## Versioning convention — 0.x while experimental

`1.0.0` is reserved until "no breaking changes except in a major bump" is a credible promise. Below 1.0, a **breaking** change is a **minor** changeset with every monorepo call site updated in the same slice and no shim; any other change is a **patch**. A major bump below 1.0 is refused (IMPACT_E004 fails the gate). (Founder rule, `docs/rfcs/2026-10-14-arki-structure.md` P8.)

## The workflow — one command, three phases

`ship` never runs `npm publish`, `git push` or `git commit` (founder decisions A-26/A-27). Every step records its result in `.release/candidates/<dir>/candidate.json` `checks`, so each phase can be rerun.

| Phase | Who | Command | Stops with |
|---|---|---|---|
| 0. Plan | agent | `bun release:arki ship --wave <id> --dry-run` | the plan; refusals (SHIP_E002 mixed changeset, IMPACT_E004) |
| 1. Version + build | agent | `bun release:arki ship --wave <id>` | SHIP_E001 and the exact `git -c commit.gpgsign=false commit -- <paths>` line |
| — Commit | orchestrator | the printed commit line | |
| 2. Freeze + check + packet | agent | `bun release:arki ship --wave <id> --resume` | `packet.md` path, or SHIP_E007 with the blockers |
| — Publish | **founder** | the `npm publish` lines in `packet.md`, from `/tmp` | |
| 3. Finish | **founder** | `bun release:arki ship --finish --candidate <dir>` | ledger entry written, package mirrors synced, wave tag pushed, demo pin bumps printed |

Details per phase: [ship-update.md](./ship-update.md). Error codes and fixes: [troubleshooting.md](./troubleshooting.md#error-codes-from-ship).

Other procedures:

| Procedure | Sub-doc |
|---|---|
| Promote a private package to a public wave | [add-new-package.md](./add-new-package.md) |
| Sync the GitHub mirrors (`arki-labs/<name>`) and tag the wave on `arki-labs/arki` | [sync.md](./sync.md) |
| Diagnose a release issue | [troubleshooting.md](./troubleshooting.md) |

## Hard rules

- **Agents run only `--dry-run`, phase 1 and `--resume`.** `ship --finish` refuses with SHIP_E004 when `CLAUDECODE` is set or stdin is not a TTY. Never work around it.
- **Apps and non-wave packages are never versioned.** `.changeset/config.json` sets `"privatePackages": { "version": false, "tag": false }`, every package outside the waves is `private: true`, and `ship` runs `changeset version --ignore <every package outside the set>`. `changeset version` also bumps dependents of bumped packages ("Updated dependencies"). A dependent in the same wave ships with it: `ship` builds it and puts it in the commit line, and `--resume` freezes it. If a bump still lands in another wave or in no wave, `ship` stops with SHIP_E002; restore those files, do not commit them.
- **`arki.release.config.ts` is the source of truth** for which packages are in which wave.
- **Never commit `.release/`** — candidates, the public tree and the package mirror checkouts are regenerated.
- **`npm publish` needs the founder's OTP** — see [troubleshooting.md](./troubleshooting.md#the-npm-otp-wall).
- **Never force-push `arki-labs/arki`** — see [troubleshooting.md](./troubleshooting.md#never-force-push-arki-labsarki).

## Sanity checks

```bash
bun release:arki ship --wave foundation --dry-run        # what would ship, and what refuses
bun release:arki scorecard --candidate <dir>             # gate on a frozen candidate
bun release:arki scorecard --candidate <dir> --table     # readiness table (warn = non-blocking gap)
bun release:arki history                                 # reconcile source / npm / CHANGELOG / mirrors
```

This skill describes the workflow only. The logic lives in `tooling/arki-release/src/*` (`ship.ts`, `candidate.ts`, `scorecard.ts`, `ledger.ts`); when they disagree, the code wins and this file gets fixed.
