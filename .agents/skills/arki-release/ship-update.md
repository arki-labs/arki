# Ship an update to an existing `@arki/*` wave package

The whole flow is `bun release:arki ship`. This page says what each phase does and what to do when it stops. It holds no logic of its own.

## Before you start: the changeset

Write `.changeset/<slug>.md`:

```md
---
'@arki/<name>': patch    # patch for fixes and additions; minor for any breaking change below 1.0
---

Short description of what changed and why.
```

- One changeset touches one wave. A changeset that bumps a package inside the wave **and** one outside is refused (SHIP_E002): split it.
- Changesets for other waves stay pending; `ship` versions only its own set.
- Explain a breaking change in `docs/upgrades/<from>-to-<to>.md`, not in the changeset.
- If the docs need no change, say why with a `no docs impact: <reason>` line; same for demos with `no demo impact: <reason>` (only when a registered demo uses the package; otherwise demo-impact passes on its own). Put the line in the package's changeset before phase 1. `changeset version` deletes the changeset, but the scorecard still reads it from git history: it accepts a reason from a pending changeset or from one consumed since the package's last release. A changeset consumed before the last release does not count.

## Phase 0 — plan (agent)

```bash
bun release:arki ship --wave <id> --dry-run --json
```

Reads the publish order and the pending changesets, then prints the plan. It runs neither `changeset version` nor the build.

## Phase 1 — version and build (agent)

```bash
bun release:arki ship --wave <id>
```

1. `order` — the publish set, unpublished `@arki/*` deps first. Stops on ORDER_E001.
2. Refusals — mixed changesets (SHIP_E002), major bumps below 1.0 (IMPACT_E004).
3. `bun node_modules/.bin/changeset version --ignore <packages outside the set>`.
4. `turbo run build --filter=<each package in the set>`.
5. Stops with **SHIP_E001** and the exact line to run:
   `git -c commit.gpgsign=false commit -- <package.json, CHANGELOG.md, consumed changesets>`.

The orchestrator reviews the diff and runs that line (pathspec only; twin sessions share the tree).

## Phase 2 — freeze, check, packet (agent)

```bash
bun release:arki ship --wave <id> --resume [--allow-demo-lag "<reason>"] [--allow-deferred]
```

1. `candidate` — packs every wave package whose version is not on npm into `.release/candidates/<wave>-<sha7>/`.
2. `smoke` — installs those tarballs in a clean consumer outside the workspace (Node and Bun) and imports every export.
3. Doc examples — runs `bun run test:docs --json` in each package that has the script; records `checks["docs:<pkg>"]`. No script is reported as such (SCORE_E007 warning), not as a failure.
4. Demo checks — each demo that uses a candidate package runs `bun run arki:candidate <dir>` (install, typecheck, test, build against the tarballs in a temp copy) and records `checks["demo:<name>"]` as `success` or `failure`; the scorecard decides. A demo folder not on disk is recorded as `deferred`. Rerun one by hand with `bun release:arki demo-check --demo <name> --candidate <dir>`.
5. `scorecard --candidate` — packlist, metadata and dependencies from the tarballs, fixtures from the smoke run, docs-fresh from the doc examples, docs-impact against the last shipped candidate.
6. If everything passes: writes `packet.md` next to `candidate.json`. Otherwise SHIP_E007 with each blocker.

## Founder: publish

Open `packet.md`. From `/tmp`, run its `npm publish --access public <abs tarball>` lines in order, then its `npm view` lines. Publishing the tarball path from `/tmp` avoids the workspace parent-walk trap.

## Phase 3 — finish (founder)

```bash
bun release:arki ship --finish --candidate <dir>
```

1. `npm view <pkg>@<version> dist.integrity` for each package, from `/tmp`. A match is skipped (never republished); a missing version is SHIP_E006 with its publish line; a different integrity is SHIP_E005.
2. Records `checks.shipped` (the next docs-impact diffs from this commit).
3. Writes the entry in `apps/arki/docs/RELEASES.md`, newest first (once per candidate).
4. Runs the mirror sync (`sync --apply`, T1.7) and records `checks.sync`.
5. Prints the demo pin bumps (`arki.deps.json` + `bun run arki:npm`).

Rerunning `--finish` is safe: verified packages are skipped and the ledger entry is not duplicated.

## Watch points

- **Peer-dependent major-bump trap** — prevented by `"onlyUpdatePeerDependentsWhenOutOfRange": true` in `.changeset/config.json`. If a release still lands a peer-dependent on `1.0.0`, check that option first.
- **Peer-dep coupling** — `@arki/env` peer-depends on `@arki/dot`; after a `@arki/dot` minor, check the peer range in source.
- **What npm packs** — each `package.json#files` decides the tarball. Most packages ship `dist` only; add `src` to `files` to ship source too (3-5x larger tarballs).
