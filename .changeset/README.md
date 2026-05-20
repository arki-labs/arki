# Changesets — ARKI Public Release Policy

This directory holds [Changesets](https://github.com/changesets/changesets)
configuration for the public `@arki/*` release pipeline.

## What gets published

Only packages in **`packages/`** whose `package.json` has `private: false`
AND that appear in a release wave (see `arki.release.config.ts`) are
candidates for npm publication. Changesets respects each package's
`private` flag automatically — all internal packages (`apps/`,
`tooling/`, anything still flagged `private: true`) are never published.

The five canonical release waves:

1. **foundation** — `@arki/assert`, `@arki/contracts`, `@arki/logger`,
   `@arki/env`, `@arki/ts`, `@arki/resilience`, `@arki/date`,
   `@arki/string`, `@arki/slugify`, `@arki/clock`
2. **dot-kernel** — `@arki/dot`
3. **infrastructure-adapters** — `@arki/db`, `@arki/kv`, `@arki/fs`,
   `@arki/queue`, `@arki/event-sourcing`, `@arki/auth`, `@arki/emails`
4. **frontend** — `@arki/design-systems`, `@arki/theme`, `@arki/icons`,
   `@arki/react-hooks`, `@arki/ui`
5. **specialized** — `@arki/ai`, `@arki/rich-text`, `@arki/images`,
   `@arki/diff-engine`

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
- `ignore: []` — Changesets respects each package's `private` flag.
  Adding an explicit ignore list is unnecessary and risks drifting from
  the canonical wave allowlist in `arki.release.config.ts`.
