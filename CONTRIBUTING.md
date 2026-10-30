# Contributing to Arki

Thanks for helping. This guide covers setup, the rules every change follows,
and how a change reaches npm.

## Setup

You need [Bun](https://bun.sh) (the version in `package.json`
`packageManager`), Node 26, and Docker for tests that start Postgres or Redis.

```sh
git clone https://github.com/arki-labs/arki.git
cd arki
bun install
bun run build
```

## Before you open a pull request

1. **Open an issue first** for anything larger than a small fix. A short
   design note saves rework.
2. **Read the principles.** [`docs/arki/principles.md`](docs/arki/principles.md)
   lists the rules every package follows. Reviews check them.
3. **Run the checks** for the packages you touched:

   ```sh
   bun run turbo run build typecheck lint test --filter=@arki/<name>
   ```

4. **Add a changeset** if a published package changes:

   ```sh
   bun run changeset
   ```

   Below `1.0`, a breaking change is a `minor` bump and everything else is a
   `patch`. Never pick `major`. A breaking change also updates every caller in
   this repo in the same pull request, with no compatibility shim.

## Rules that reviews enforce

- **No `any`, no `@ts-ignore`, no unsafe casts.** TypeScript runs in strict mode.
- **Every type is written once.** Declare it at its source and infer it
  everywhere else. When a TS type and a runtime schema must both exist, lock
  them together with a two-way type test.
- **Schemas own validation.** Unknown values become typed only through a
  Standard Schema. No hand-written type guards on `unknown`.
- **Failures are values.** Expected errors are returned with a stable code.
  Throw only for bugs.
- **No `console.log`.** Libraries log through `@arki/log` at `debug` level and
  never call `configure()`.
- **Tests use real objects.** Real Postgres, real Redis, the real public API.
  Fake only time, randomness and paid services.
- **Docs are tested.** Code blocks marked `ts run` in a README run in CI
  (`bun run test:docs`).

## Package layout

```text
packages/<name>/
  src/            source
  docs/           agent guide and deep docs
  examples/       runnable examples, typechecked in CI
  README.md       the human entry point
  llms.txt        the agent entry point
  CHANGELOG.md    written by changesets
```

## How releases work

Maintainers release in waves (see `arki.release.config.ts`). The release tool
builds tarballs, runs the scorecard (leak scan, pack audit, fixture install,
consumer smoke) and publishes only the checked tarballs. You do not need to
run it for a pull request.

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org), scoped to the
package: `fix(date): handle leap seconds in fromUnix`.

## Code of conduct

Everyone here follows the [Code of Conduct](CODE_OF_CONDUCT.md).
