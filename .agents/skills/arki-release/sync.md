# Sync the GitHub mirrors (`sync`)

One command mirrors a release to GitHub. It covers the public monorepo `arki-labs/arki` and the read-only repo of each package, `arki-labs/<name>`. It replaces the two older mirror procedures. There is no alias.

## Two halves

| Command | Who | What it does |
|---|---|---|
| `bun release:arki sync --prepare [--candidate <dir>] [--json]` | agents and you | Local. Reads the network (fetch, npm). Never pushes, never runs a `gh` write. |
| `bun release:arki sync --apply [--plan <path>]` | **founder only** | Pushes, tags, creates the GitHub Releases. |

`--apply` refuses with `MSYNC_E001` when `CLAUDECODE` is set, and with `MSYNC_E002` when stdin is not a terminal. Never run it from an agent session.

## What `--prepare` does

1. Takes the tarballs from `--candidate <dir>` (hashes checked), or `npm pack`s the published version of every admitted package.
2. For each package, rebuilds `.release/package-mirrors/<name>/` from its tarball:
   - `README.md` gets a generated first line: "Read-only mirror of `@arki/<name>` v<x>. Source and issues: arki-labs/arki. Docs: https://arki.dev/packages/<name>. Published <date> with provenance <npm link>."
   - `SECURITY.md` is added (text lives in `SECURITY_MD` in `src/sync.ts`).
   - It commits on top of the remote `main` and creates the annotated tag `v<version>` locally.
   - Release notes are that version's CHANGELOG entry. Assets are the tarball, plus `api.json` if the tarball has one.
3. Exports the public tree (committed state, with the workspaces root so cloners can `bun install`) and commits it on top of `.release/arki-mirror` (a checkout of `arki-labs/arki`) with the annotated tag `v<wave>-<date>`.
4. Writes `.release/sync-plan.json` and staging files under `.release/sync/`.

Check the result: `bun release:arki sync --prepare --json | jq '.items | length'`, then read `git -C .release/arki-mirror show --stat HEAD`. If other packages show up than the ones you release, stop and fix the export before `--apply`.

## What `--apply` does

For each package mirror, then the wave:

1. Creates the repo with `gh repo create arki-labs/<name> --public --disable-issues --disable-wiki` if it does not exist.
2. `git push origin main` and `git push origin <tag>`. Never `--force`.
3. `gh release create <tag> --notes-file … <assets>`.

It skips a tag that is already on the remote and a Release that already exists, and records progress in the plan. If it stops half way, run it again.

## Rules that do not change

- Never force-push `arki-labs/arki`. If a push is rejected, `origin/main` moved. Run `git -C .release/arki-mirror log --oneline main..origin/main`. If you do not recognize it, stop and ask. Otherwise run `--prepare` again, then `--apply`.
- Published tags never move. Moving one needs explicit founder approval and is done by hand.
- The mirror checkouts must be their own git repos. If git reports the monorepo as the top level (`MSYNC_E007`), delete the directory and prepare again. Without that guard `git add -A` would stage the whole monorepo.
- A dirty mirror (`MSYNC_E006`) means an earlier run left changes. Read `git -C <dir> status`. If nothing matters, delete the directory and prepare again.
- `.release/` is gitignored. Mirrors are disposable.

## Error codes

| Code | Meaning |
|---|---|
| `MSYNC_E001` | Apply refused: agent session. |
| `MSYNC_E002` | Apply refused: no terminal. |
| `MSYNC_E003` | Sync plan missing or invalid. |
| `MSYNC_E004` | Candidate unusable. |
| `MSYNC_E005` | A git command failed. |
| `MSYNC_E006` | Mirror checkout is dirty. |
| `MSYNC_E007` | Mirror is not its own git checkout. |
| `MSYNC_E008` | Tarball pack, verify or unpack failed. |
| `MSYNC_E009` | Public tree export failed. |
| `MSYNC_E010` | A `gh` command failed. |
| `MSYNC_E011` | A push was rejected. |

## Verify after apply

```bash
git ls-remote --tags git@github.com:arki-labs/<name>.git      # has v<version>
gh release view v<version> --repo arki-labs/<name>             # has notes and assets
gh release view v<wave>-<date> --repo arki-labs/arki
bun release:arki history | tail -5                             # mirrors: in-sync
```
