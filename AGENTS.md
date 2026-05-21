# AGENTS.md

> Agent-discoverable contract for `arki-labs/arki`. Read this first if you
> are an autonomous coding agent landing in this repository.

## What this repo is

The public ARKI release tree. Every `packages/<name>` directory is an
independently-versioned npm package under the `@arki/*` scope. The root
is a private workspace whose only job is to host those packages and the
release pipeline that publishes them.

## Where to look

- `packages/dot/docs/principles.md` — **read first.** The five rules every
  API, error, and PR is measured against. Slightly playful, very precise.
- `packages/dot/README.md` — DOT framework reference (what a pip is, the
  `defineApp` + `defineDotPip` API, lifecycle hooks, CLI).
- `packages/<name>/README.md` — per-package contract and examples.
- `.changeset/` — how versions and changelogs are produced.
- `.github/workflows/release.yml` — how packages get published.

## How to propose changes

Source code is mirrored from an upstream workspace, so direct PRs against
`packages/**` will be overwritten on the next export. Open an issue with
a minimal reproducer or design proposal instead — maintainers land the
change upstream and re-export.

## Stable contracts

Every `@arki/*` package follows semver. DOT's pip contract (`DotPip`,
`defineDotPip`), `DotAppManifest`, and `DotDiagnosticsSnapshot` are versioned
as part of `@arki/dot` — read its CHANGELOG before upgrading.
