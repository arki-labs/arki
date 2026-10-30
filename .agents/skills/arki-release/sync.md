# Sync the GitHub mirrors (`sync`)

One command takes a release to GitHub. It covers the read-only repo of each package, `arki-labs/<name>`, and the wave tag on `arki-labs/arki`. It replaces the two older mirror procedures. There is no alias.

Since 2026-10-30 this repo *is* `arki-labs/arki`. It is the real source, not a mirror. So `sync` never writes a commit here and never pushes `main`. It only adds one annotated tag per wave.

## Two halves

| Command | Who | What it does |
|---|---|---|
| `bun release:arki sync --prepare [--candidate <dir>] [--json]` | agents and you | Local. Reads the network (fetch, npm). Never pushes, never runs a `gh` write. |
| `bun release:arki sync --apply [--plan <path>]` | **founder only** | Pushes the package mirrors and the tags, creates the GitHub Releases. |

`--apply` refuses with `MSYNC_E001` when `CLAUDECODE` is set, and with `MSYNC_E002` when stdin is not a terminal. Never run it from an agent session.

## What `--prepare` does

1. Takes the tarballs from `--candidate <dir>` (hashes checked), or `npm pack`s the published version of every admitted package.
2. For each package, rebuilds `.release/package-mirrors/<name>/` from its tarball:
   - `README.md` gets a generated first line: "Read-only mirror of `@arki/<name>` v<x>. Source and issues: arki-labs/arki. Docs: https://arki.dev/packages/<name>. Published <date> with provenance <npm link>."
   - `SECURITY.md` is added (text lives in `SECURITY_MD` in `src/sync.ts`).
   - It commits on top of the remote `main` and creates the annotated tag `v<version>` locally.
   - Release notes are that version's CHANGELOG entry. Assets are the tarball, plus `api.json` if the tarball has one.
3. Puts the annotated tag `v<wave>-<date>` on the candidate's source commit in this repo (on `HEAD` when there is no candidate). It exports no tree and makes no commit. If the tag is already on `origin`, it skips it. If a local tag of that name points at another commit, it stops with `MSYNC_E012`.
4. Writes `.release/sync-plan.json` and staging files under `.release/sync/`.

Check the result: `bun release:arki sync --prepare --json | jq '.items'`, then `git show --stat v<wave>-<date>`. The tag must sit on the commit the candidate was frozen from. If other packages show up than the ones you release, stop before `--apply`.

## What `--apply` does

For each package mirror, then the wave:

1. Creates the repo with `gh repo create arki-labs/<name> --public --disable-issues --disable-wiki` if it does not exist.
2. `git push origin main`, only when prepare made a new commit (package mirrors only; the wave never has one). Then `git push origin <tag>`. Never `--force`.
3. `gh release create <tag> --notes-file … <assets>`.

It skips a tag that is already on the remote and a Release that already exists, and records progress in the plan. If it stops half way, run it again.

## Rules that do not change

- Never force-push. If a package mirror push is rejected, its `origin/main` moved. Run `git -C .release/package-mirrors/<name> log --oneline main..origin/main`. If you do not recognize it, stop and ask. Otherwise run `--prepare` again, then `--apply`.
- `sync` never pushes this repo's `main`. Push your own source changes yourself, with a plain `git push`.
- Published tags never move. Moving one needs explicit founder approval and is done by hand.
- The package mirror checkouts must be their own git repos. If git reports the monorepo as the top level (`MSYNC_E007`), delete the directory and prepare again. Without that guard `git add -A` would stage the whole monorepo.
- A dirty mirror (`MSYNC_E006`) means an earlier run left changes. Read `git -C <dir> status`. If nothing matters, delete the directory and prepare again.
- `.release/` is gitignored. Package mirror checkouts are disposable.

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
| `MSYNC_E009` | Retired (was: public tree export failed). Never reused. |
| `MSYNC_E010` | A `gh` command failed. |
| `MSYNC_E011` | A push was rejected. |
| `MSYNC_E012` | A local wave tag points at another commit. Published tags never move. |

## Verify after apply

```bash
git ls-remote --tags git@github.com:arki-labs/<name>.git      # has v<version>
gh release view v<version> --repo arki-labs/<name>             # has notes and assets
gh release view v<wave>-<date> --repo arki-labs/arki
bun release:arki history | tail -5                             # mirrors: in-sync
```
