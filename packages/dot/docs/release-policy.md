# Release Policy

`@arki/dot` follows SemVer with an explicit stability contract — what is
covered, what is not, and how breaking changes get announced.

## SemVer

`MAJOR.MINOR.PATCH`:

- **MAJOR** — backward-incompatible change to the public API.
- **MINOR** — backward-compatible additions (new hooks, new manifest
  fields, new CLI commands).
- **PATCH** — bug fixes, doc fixes, internal refactors.

The current line is `0.x`. **`0.x` is API-experimental** — minor versions
can include breaking changes. Once `1.0` ships, the SemVer contract above
becomes binding.

## Public surface

These are the **stable contracts** as of `0.1`:

| Surface                          | Stability  |
| -------------------------------- | ---------- |
| `defineApp(name, options?)`      | stable     |
| `.use(plugin)` typed builder     | stable     |
| `defineDotPlugin(config)`        | stable     |
| `DotPlugin` shape (5 hooks)      | stable     |
| `DotLifecycleHook` enum          | stable     |
| `DotLifecycleState` enum         | stable     |
| `DotLifecycleError` shape        | stable     |
| `DotAppManifest` (5 arrays)      | stable     |
| `DotDiagnosticsSnapshot`         | stable     |
| `DiagnosticIssue` shape          | stable     |
| `dot explain` CLI + JSON envelope| stable     |
| `dot doctor` CLI + JSON envelope | stable     |
| `testApp` / `bootTestApp`        | stable     |

These are **experimental** in `0.x` and may change without a major bump:

- `dot new` and `dot add` (deferred to `0.x`/`1.1`).
- Internal kernel modules (`@arki/dot/kernel/*`).
- The legacy surface (`createDot`, `definePlugin`, legacy auth/db/event-
  sourcing exports under `@arki/dot/legacy`).

The legacy surface is **deprecated** and exists only for in-monorepo
consumer migration. It will be removed in `1.0`.

## Deprecation cycle

1. **Deprecate** — mark with `@deprecated` JSDoc, log a one-time
   `console.warn` when the deprecated symbol is used at runtime, document
   the replacement.
2. **One minor** — leave the deprecated symbol in place for at least one
   minor release.
3. **Remove** — remove in the next major.

Example timeline:

| Version | Action                                       |
| ------- | -------------------------------------------- |
| `0.3.0` | Deprecate `createDot`. Document replacement. |
| `0.4.0` | Deprecation still active.                    |
| `1.0.0` | Remove `createDot`.                          |

Deprecations and removals are listed in the [upgrade guide](./upgrade-guide.md).

## Public vs experimental imports

| Import path                | Status        |
| -------------------------- | ------------- |
| `@arki/dot`                | stable        |
| `@arki/dot/plugin`         | stable        |
| `@arki/dot/legacy`         | deprecated    |
| `@arki/dot/kernel/*`       | experimental — do not import directly |
| `@arki/dot/cli`            | experimental — wraps the binary; use the `dot` CLI instead |

Anything not listed is private. We reserve the right to change private
modules at any time.

## Adapter versioning

Adapters (`@arki/env/dot`, `@arki/kv/dot`, `@arki/db/dot`) declare
`@arki/dot` as an **optional peer** with a `^` range. They follow their
own SemVer line independent of the kernel.

When `@arki/dot` makes a breaking change, adapters bump their peer range
to reflect the minimum compatible kernel version. Users see a peer-dep
warning from their package manager if they install a mismatched pair.

## Changesets workflow

Every PR that changes a public symbol must include a changeset (a
markdown file under `.changeset/`) describing:

- The packages affected.
- The bump type (`major` / `minor` / `patch`).
- A one-sentence summary suitable for the changelog.

`bun release:arki` publishes the changesets as `CHANGELOG.md` entries on
each package.

## Migration notes

Every breaking change ships with:

- A `CHANGELOG.md` entry under the new version.
- A section in the [upgrade guide](./upgrade-guide.md) describing what
  changed, why, and how to migrate.
- Where automatable, a codemod published alongside the release.

The upgrade guide is the **single source of truth** for "I'm on 1.0, how
do I get to 2.0?". Skim it before any major bump.

## Stability gates

A release is only stamped stable once:

- The full leak scanner audit returns zero error hits.
- The fixture matrix (npm / pnpm / bun) passes on every public package.
- The scorecard for every public package is `pass` on every dimension
  except `agent-native-gates` (which is informational).
- The internal consumer migration has covered every production app.

See `tooling/arki-release` for the gate implementations.

## See also

- [Upgrade guide](./upgrade-guide.md) — concrete migration notes by version.
- [Diagnostics](./diagnostics.md) — the stable data contracts that
  third-party tools depend on.
