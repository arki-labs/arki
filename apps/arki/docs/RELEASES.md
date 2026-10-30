# ARKI Release Ledger

Append-only chronological record of every `@arki/*` npm publication and `arki-labs/arki` mirror sync. **Newest at top.** Each entry lists packages, versions, surfaces (npm + GitHub), the scorecard verdict, and any operational notes.

This file is the **human-readable** truth. The **machine-readable** truth lives in:

- `npm view @arki/<pkg> versions --json` — npm registry
- `git ls-remote --tags git@github.com:arki-labs/arki.git` — GitHub mirror tags
- `packages/<pkg>/package.json#version` — monorepo source
- `bun release:arki history` — reconciliation tool that cross-checks all three

When the ledger and the tool disagree, **trust the tool**, then correct the ledger.

---

## Wave 1 — Foundation (foundation) @ bc952ff (2026-10-30)

<!-- candidate: foundation-bc952ff -->

**Packages shipped** (9, in publish order):

| Package | Version | Order |
| ------- | ------- | ----- |
| @arki/failure | 0.3.0 | 1 |
| @arki/log | 0.3.1 | 2 |
| @arki/ts | 0.1.0 | 3 |
| @arki/clock | 0.2.0 | 4 |
| @arki/schema | 0.3.0 | 5 |
| @arki/string | 0.4.1 | 6 |
| @arki/async | 0.2.0 | 7 |
| @arki/contracts | 0.4.0 | 8 |
| @arki/date | 0.4.0 | 9 |

**Source commit**: `bc952ff794c197f29543bc316d3fe13743560dc9`. Tarballs verified on npm by `dist.integrity`.

**Scorecard at publish**: `OPEN` (9 pass, 0 warn, 0 fail, 0 deferred).

**Candidate checks**: `demo:drop-studio` deferred, `demo:faultline` deferred, `docs:@arki/async` success, `docs:@arki/clock` success, `docs:@arki/contracts` success, `docs:@arki/date` success, `docs:@arki/failure` success, `docs:@arki/log` success, `docs:@arki/schema` success, `docs:@arki/string` success, `docs:@arki/ts` success, `published:@arki/async` success, `published:@arki/clock` success, `published:@arki/contracts` success, `published:@arki/date` success, `published:@arki/failure` success, `published:@arki/log` success, `published:@arki/schema` success, `published:@arki/string` success, `published:@arki/ts` success, `runtimes:@arki/ts` success, `scorecard` success, `smoke` success.

**GitHub mirror**: `sync --apply` runs after this entry; its result is `checks.sync` in `.release/candidates/foundation-bc952ff/candidate.json`.

---

## Deprecated — `@arki/event-sourcing` (2026-10-13)

**npm only.** All 9 published versions (`0.1.0`–`0.1.5`, `0.2.1`–`0.2.3`) are deprecated with the message
"Retired and no longer maintained. Its successor is @arki/journal (not yet published)." Nothing was unpublished.

**Why**: the package (an Emmett wrapper) is removed from the monorepo; every app writes through `@arki/journal`.
When `@arki/journal` ships, the message can be rerun as "Use @arki/journal instead."

**GitHub mirror**: no sync; the next mirror sync drops `packages/event-sourcing`.

## v0.1.0 — Wave 2 (dot kernel) + Wave 3 (infra adapters) (2026-05-21)

**Packages shipped** (4, all at `0.1.0`):

| Package              | Wave                     | First published | Track        |
| -------------------- | ------------------------ | --------------- | ------------ |
| @arki/dot            | dot-kernel               | 2026-05-21      | experimental |
| @arki/db             | infrastructure-adapters  | 2026-05-21      | experimental |
| @arki/kv             | infrastructure-adapters  | 2026-05-21      | experimental |
| @arki/event-sourcing | infrastructure-adapters  | 2026-05-21      | experimental |

**GitHub mirror**: `arki-labs/arki main` force-pushed; tag `v0.1.0` annotated.

**Scorecard at publish**: `OPEN` (14 pass, 0 warn, 0 fail).

**Track meaning** (`0.1.x`): same experimental contract as Wave 1's `0.0.x`. The `0.1.x` prefix only signals "kernel/adapter layer — past first integration with a real consumer," **not** "API stable." Wave 1's foundation utilities are zero-dep utilities; Wave 2/3 are composition primitives — both equally experimental.

**Dependency-order ship sequence**: `@arki/dot` first (alone), then the three Wave 3 adapters together. `@arki/db`, `@arki/kv`, and `@arki/event-sourcing` all peer-depend on `@arki/dot ^0.1.0` — publishing them before dot would have produced unsatisfied-peer warnings on every install. Order was strictly enforced and verified via `bun release:arki history` between batches.

**Operational notes**:

- Source had Wave 2/3 at `0.1.1`; manually rolled back to `0.1.0` for the first publication to match the experimental-track honesty pattern (matched what Wave 1 did at `0.0.1`). The materializer then rewrote the peer ranges in `db`/`kv`/`event-sourcing` from `^0.1.1` → `^0.1.0` automatically.
- Per-package `CHANGELOG.md` files were rewritten before ship (the stale changeset cascade referenced `@arki/assert@1.0.0` etc. — none of which exist). Each Wave 2/3 CHANGELOG now carries a fresh `## 0.1.0 / Initial release` entry with rationale for the version-tier choice.
- **`npm publish` from inside `.release/arki-public/packages/<pkg>/` failed with `'@arki/dot@*' is not in this registry`** — root cause: the materializer writes a workspaces-root `package.json` at `.release/arki-public/`, and `npm publish` walked up to find it, switching to workspace mode (which fails on standalone publication of a scoped package). **Workaround**: use the path-form `npm publish --access public /absolute/path/to/packages/<pkg>` from any directory *outside* the workspace tree. Skill troubleshooting updated.
- npm 2FA web-based authentication can look mid-flight like it stalled. First publish succeeded immediately; the user retried before the browser auth completed, hitting a benign duplicate-publish 403. The retry-after-success pattern is harmless — verify with `npm view <pkg> version` before retrying.

---

## v0.0.1 — Wave 1 foundation (2026-05-21)

**Packages shipped** (10, all at `0.0.1`):

| Package          | First published | Track        |
| ---------------- | --------------- | ------------ |
| @arki/assert     | 2026-05-21      | experimental |
| @arki/clock      | 2026-05-21      | experimental |
| @arki/contracts  | 2026-05-21      | experimental |
| @arki/date       | 2026-05-21      | experimental |
| @arki/env        | 2026-05-21      | experimental |
| @arki/log        | 2026-05-21      | experimental |
| @arki/resilience | 2026-05-21      | experimental |
| @arki/slugify    | 2026-05-21      | experimental |
| @arki/string     | 2026-05-21      | experimental |
| @arki/ts         | 2026-05-21      | experimental |

**GitHub mirror**: `arki-labs/arki main` force-pushed; tag `v0.0.1` annotated.

**Scorecard at publish**: `OPEN` (14 pass, 0 warn, 0 fail).

**Track meaning** (`0.0.x`): API stability is *not* claimed. The version certifies "first publishable artifact passing all release gates," not "field-tested." Breaking changes may land at any `0.0.x` boundary until the kernel earns a `0.1.0` promotion through real consumer reuse.

**Wave 2 / Wave 3 status**: `@arki/dot` (Wave 2) and `@arki/db`, `@arki/kv`, `@arki/event-sourcing` (Wave 3) sit in the materialized tree at v0.1.1 on `arki-labs/arki main` but are **not yet on npm**. The chicken-and-egg gate (transitive `@arki/*` deps unresolvable until Wave 1 lands) is now lifted — publication is pending Wave-2 ship-readiness review.

**Operational notes**:

- Initial publication was attempted at `1.0.0`. Corrected to `0.0.1` before npm publish — the v1.0 prefix implied API stability we hadn't earned. `package.json#version` was rewritten via `sed` (surgical, no JSON re-encoding); the per-package `CHANGELOG.md` files were missed in that pass.
- As a result, the v0.0.1 tarballs already on npm contain `# 1.0.0` CHANGELOG headings inside them. **This is a frozen artifact** — npm tarball contents cannot be edited post-publish. The correction lands in the next tarball (Wave 2 or a v0.0.2 patch).
- The `# 1.0.0` headings in monorepo source were corrected the same day in a follow-up commit; that commit also created this ledger and added `bun release:arki history`.

---

## How to add a new entry

When you ship, **prepend** a section to the top of the ledger (above the previous most-recent entry) with:

1. **Title**: `## v<version> — <release codename> (<YYYY-MM-DD>)`
2. **Packages table**: name, first-published date for this *specific* version, track (experimental / pre-release / stable).
3. **GitHub mirror**: branch + tag state after force-push.
4. **Scorecard**: verdict at publish time (`OPEN` / passes / warns / fails).
5. **Track meaning**: brief reminder of what the semver prefix promises (or doesn't).
6. **Operational notes**: anything that diverged from happy-path — OTP retries, republishes, fixture skips, manual edits, doctrine exceptions.

**Do not edit old entries** except to correct factual errors. Keep them as a historical record. If you correct an old entry, append a `**Correction (YYYY-MM-DD):** …` line at the bottom of that entry rather than rewriting in place.

---

## Why this file exists

Six places carry "what's released" state today: npm registry, GitHub tags, monorepo `package.json#version`, per-package `CHANGELOG.md`, `.changeset/` pending entries, and conversational memory. None of them is authoritative on its own — they drift. This ledger is the **narrative** layer that tells you which release happened when, what it actually contained, and what went sideways. `bun release:arki history` is the **reconciliation** layer that detects drift between the other five.

Together they form the answer to "what's released" — the ledger for context, the tool for ground truth.
