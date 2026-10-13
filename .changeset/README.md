# Changesets — ARKI Public Release Policy

This directory holds [Changesets](https://github.com/changesets/changesets)
configuration for the public `@arki/*` release pipeline.

## What gets published

Only packages in **`packages/`** whose `package.json` has `private: false`
AND that appear in a release wave (see `arki.release.config.ts`) are
candidates for npm publication. Changesets respects each package's
`private` flag automatically — all internal packages (`apps/`,
`tooling/`, anything still flagged `private: true`) are never published.

The canonical release waves (active set — see `arki.release.config.ts`
for the source of truth; trimmed for stable v1 per the doctrine
"smaller and excellent rather than broad and uneven"):

1. **foundation** — `@arki/assert`, `@arki/contracts`, `@arki/log`,
   `@arki/env`, `@arki/ts`, `@arki/resilience`, `@arki/date`,
   `@arki/string`, `@arki/clock`
2. **dot-kernel** — `@arki/dot`
3. **infrastructure-adapters** — `@arki/db`, `@arki/kv`, `@arki/http`, `@arki/journal`
   (`fs`/`queue`/`auth`/`emails` rejoin once they ship dist+docs / drop
   `private: true`)
4. **frontend** — _empty for v1.0_; every Wave 4 candidate still
   fails build-output / docs / privacy or depends on the
   still-private `@arki/react-hooks`. Targeted for v1.1.
5. **specialized** — `@arki/money` (depends on `@arki/math`), `@arki/payments`; the other
   Wave 5 candidates are still `private: true`. Targeted for v1.1+.

## Gating

Stable release is **blocked** by the `arki-release scorecard` command
until every public-candidate passes every dimension (metadata, privacy,
dependencies, build-output, packlist, docs, fixtures, DOT gates,
agent-native gates). See `.github/workflows/arki-release-gates.yml`.

## Workflow

1. Make a change to a public `@arki/*` package.
2. Run `bunx changeset` and follow the prompts to write a changeset.
3. Push the changeset alongside the change. CI runs:
   - `bun release:arki inventory --json`
   - `bun release:arki audit --json`
   - `bun release:arki pack --json`
   - `bun release:arki export-public --json`
   - `bun release:arki fixture --json`
   - `bun release:arki scorecard --json`
4. CI blocks the merge if the scorecard reports `stableReleaseGate:
   "blocked"`.
5. For canary releases, push the merged change to a release branch and
   run `bunx changeset version --snapshot canary && bunx changeset
   publish --tag canary`.

## Configuration

- `access: "public"` — every published package goes to public npm.
- `baseBranch: "master"` — Changesets diffs against master.
- `updateInternalDependencies: "patch"` — when a public package's
  internal `@arki/*` dep bumps, this package gets at least a patch bump
  so consumers receive the transitive update.
- **Peer-dependent trap**: when a _peerDependency_ (e.g. `@arki/dot`
  for the adapters) gets a **minor or major** bump, Changesets
  major-bumps every peer-dependent — landing them on the
  founder-reserved `1.0.0`. After any non-patch dot release, correct
  the cascade versions manually (sed, Path B in the arki-release
  skill) before materializing. Patch bumps of peers cascade as
  patches and are unaffected.
- `ignore: []` — Changesets respects each package's `private` flag.
  Adding an explicit ignore list is unnecessary and risks drifting from
  the canonical wave allowlist in `arki.release.config.ts`.
