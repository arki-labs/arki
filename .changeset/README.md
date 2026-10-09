# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets)
configuration for the ARKI public release pipeline.

## Author flow (maintainers)

Changesets are authored in the upstream private workspace. When the
export-public job runs, the entire `.changeset/` directory (except this
README and `config.json`) is mirrored here so the `changesets/action`
step can see the pending bumps.

## Consumer flow

1. Maintainer pushes to `main` carrying one or more changeset entries.
2. `changesets/action` opens a `Version Packages` PR that consumes the
   entries and bumps each affected package + dependents.
3. Merging the PR triggers `changeset publish`, which:
   - runs the gates one more time,
   - publishes the bumped packages to npm under `@arki/*`,
   - creates a GitHub Release per published package.

## Canary releases

For canary publishing, run `workflow_dispatch` on `release.yml` with
`canary` set to `true`. The workflow runs:

```bash
bunx changeset version --snapshot canary
bunx changeset publish --tag canary --no-git-tag
```

Canary tags never become "latest" on npm — install them explicitly via
`bunx @arki/dot@canary` etc.
