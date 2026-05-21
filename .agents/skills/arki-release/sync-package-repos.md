# Sync the per-package read-only mirrors at `arki-labs/<name>`

Every published `@arki/<name>` package has (or should have) a corresponding **read-only** GitHub repo at `https://github.com/arki-labs/<name>` — e.g. `arki-labs/assert`, `arki-labs/dot`, `arki-labs/db`. Each repo contains:

- One commit per published npm version, in chronological order.
- A `v<version>` tag for every published version.
- A short `MIRROR.md` noting the canonical source-of-truth is `arki-labs/arki`.
- The exact contents of each version's npm tarball (so anything in `files:` ends up here — typically `dist/` + manifest + README + LICENSE).
- A **`[Read-only mirror]`** prefix on the GitHub repo description (the only "read-only" signal we ship; Issues and Wiki are disabled at create time).

The repos are **NOT archived** — that was the previous model and added an operational unarchive→push→re-archive dance with no benefit beyond an arguably-clearer-banner. The description banner + disabled Issues/Wiki are sufficient.

## When to run this

| Situation | What to do |
|---|---|
| You just shipped a new npm version for any wave-listed package | Run the sync. |
| `bun release:arki history` reports `missing` / `tag-drift` on the mirror dimension | Run the sync. |
| You bulk-created the mirrors and want to verify state | Run `--dry-run` first to see the plan. |
| You promoted a new `@arki/<name>` to a wave (after `add-new-package.md`) | The sync picks it up automatically from the wave allowlist. |
| You changed the npm description for a package | Run the sync — the `[Read-only mirror]` banner is re-stamped from the latest npm `description`. |

Don't run this when:

- The package isn't published to npm yet (the sync no-ops with `skipped: package not yet published to npm`).
- You want to update a single private/internal package (mirrors only exist for wave-listed packages).

## Decision matrix

| Situation | Path |
|---|---|
| First-ever bulk creation of all mirrors | **A — full sync, no flags** (incremental by default; new repos get created) |
| Verify the plan before touching anything | **B — dry-run** (`--dry-run` — no `gh repo create`, no `git push`, no description stamp) |
| Rebuild one mirror's history from scratch (e.g. after a yanked version) | **C — `--force --package @arki/<name>`** (force-rebuilds the commit chain for that package only) |

## Path A — Full sync (most common)

```bash
# 1. (Optional) dry-run to preview what will happen.
bun tooling/arki-release/src/cli.ts sync-package-repos --dry-run

# 2. Real run. Creates missing repos, pushes new versions/tags, stamps the
#    `[Read-only mirror]` banner into the description.
bun tooling/arki-release/src/cli.ts sync-package-repos

# 3. Reconcile — should report 'mirrors: N in-sync'.
bun tooling/arki-release/src/cli.ts history | tail -5
```

The tool reuses the wave allowlist from `arki.release.config.ts` — every package in any wave gets a mirror.

## Path B — Dry-run

```bash
bun tooling/arki-release/src/cli.ts sync-package-repos --dry-run
```

Reports one row per wave-listed package, with `status: skipped` and a `reason` describing what WOULD happen (create + push + stamp, push + stamp, or no-op). No `gh repo create`, no `git push`, no description-stamp call. Safe to run any time.

## Path C — Force rebuild for one package

```bash
bun tooling/arki-release/src/cli.ts sync-package-repos \
  --package "@arki/dot" \
  --force
```

`--force` walks every published version and force-pushes the rebuilt commit chain. Use when:

- A version was yanked from npm and the mirror's commit chain needs to align with the new published set.
- The commit history got hand-edited by mistake.
- You changed the canonical `MIRROR.md` text and want it backfilled across all commits.

`--package` repeats for multiple packages: `--package @arki/dot --package @arki/db`.

## The read-only signal: description prefix

Every mirror gets its description set to:

```
[Read-only mirror] <whatever the npm package.json description is>
```

Capped at GitHub's 350-character limit. Visible on:

- The repo home page right-sidebar.
- The org listing page at `https://github.com/orgs/arki-labs/repositories`.
- Search results.
- The `gh repo view` output.

The sync re-stamps this on every run (idempotent), so if the npm description changes upstream, the mirrors catch up on the next sync. Issues and Wiki are disabled at create-time (`--disable-issues --disable-wiki`) so the only intake surface left is PRs — those go to `arki-labs/arki`, not the mirrors.

## What gets pushed into each mirror

For every published `@arki/<name>@<version>` tarball:

```
arki-labs/<name>/
├── MIRROR.md             ← auto-generated; points back to arki-labs/arki
├── package.json          ← from the npm tarball (dependencies already resolved)
├── README.md             ← if shipped
├── LICENSE               ← if shipped
└── dist/
    ├── index.js
    ├── index.d.ts
    └── …                 ← whatever the package.json `files` array carried
```

Note: `src/` is NOT in the mirror unless a package opted `"src"` into its `files` array (Wave 1 packages currently don't). The mirror is **what npm has**, not the original TypeScript source — that lives in `arki-labs/arki`.

## Authoring identity

Commits in the mirrors are authored as:

```
Author:    ARKI Release Bot <bot@arki-labs.org>
Committer: ARKI Release Bot <bot@arki-labs.org>
Date:      <npm publish timestamp from `npm view ... time.<version>`>
```

This keeps the `git log` story honest: commit dates match real publish timestamps so a year-by-year archeology dig actually works.

## Watch points

- **Branch is `main`** — the tool initializes with `git init -b main`. If your local git defaults to `master`, no need to override — the temp dir is isolated.
- **Force push is intentional** — the mirror is deterministically reconstructable from npm. Any divergence on the mirror is drift to be overwritten.
- **`--allow-empty` is set on commits** — to handle the (rare) edge case where two consecutive published versions ship identical bytes (e.g. a metadata-only re-tag). Keeps the commit chain 1:1 with the version chain.
- **No archive flip** — under the new doctrine, mirrors stay unarchived. The read-only signal is the description prefix + disabled Issues/Wiki. If a mirror needs to be archived for some external reason (e.g. EOL'ing a package), do it manually with `gh repo archive arki-labs/<name>`.
- **Description re-stamp is idempotent** — the helper reads the current description, compares to the desired `[Read-only mirror] <npm desc>`, and only invokes `gh repo edit` if they differ.
- **No retry** — every gh/git/npm call is single-shot. Network blips manifest as `failed` items; re-run the sync (just for the failed package, via `--package`) to retry.

## Verification checklist after a sync

- [ ] `bun release:arki history` → every wave-listed package shows `mirror: in-sync`.
- [ ] `git ls-remote --tags git@github.com:arki-labs/<name>.git` → tags match `npm view @arki/<name> versions --json`.
- [ ] `gh api repos/arki-labs/<name> --jq '.description'` → starts with `[Read-only mirror]`.
- [ ] The mirror's `MIRROR.md` is present on the default branch.
- [ ] No `failed` items in the sync envelope.

## Stable error codes

- `SYNC_E001` — gh API call failed (lookup, create, description edit).
- `SYNC_E002` — npm view or tarball fetch failed.
- `SYNC_E003` — local git operation failed (init / commit / tag / push).
- `SYNC_E004` — tarball extraction or temp-dir setup failed.
- `SYNC_E005` — sync skipped for a non-fatal reason (`--package` matched nothing, etc.).
