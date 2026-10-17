---
'@arki/dot': patch
---

Docs standard: the README now opens with install, quick start, when not to use Dot, runtime support, public imports, failure behaviour and limits. The dependency-injection material moved to `docs/di.md`, the complex setup to `docs/complex-setup.md`, and the CLI, testing and operations sections to their own pages. The quickstart is a task-first tutorial whose command output is checked by the doc tests. New: `AGENTS.md`, `docs/recipes/deploy.md`, `docs/recipes/upgrade.md`, `@fix`/`@verify` on every error code. Internal plans under `docs/plans/` no longer ship in the tarball.

The `dot.app_lifecycle_failed` remediation now says to read `error.data.underlyingCode` and apply that code's remediation. It used to blame a `configure` hook that throws or returns a Promise, which was wrong when the cause is `ARKI_DOT_E020` (a provider mounted after its consumer).

no demo impact: documentation and doc-example changes, plus one CLI remediation string; no runtime behaviour changes
