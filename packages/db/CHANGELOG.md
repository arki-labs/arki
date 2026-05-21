# @arki/db

## 0.1.0

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  **`@arki/db`** is the database adapter for the ARKI kernel — the Wave 3 infrastructure layer that plugs into `@arki/dot` via the pip-and-adapter contract. It provides:

  - **PGlite + Drizzle ORM** runtime — embedded Postgres with type-safe queries
  - **DOT lifecycle integration** — registers as a `database` pip, contributing to `DotAppManifest.database` + `DotDiagnosticsSnapshot.database`
  - **`runtime-local` preset** — single-binary embedded mode for self-hosted deployments

  **Why `0.1.x`, not `0.0.x`**: same rationale as `@arki/dot` — adapter layer, experimental but past first integration. `0.1.x` signals "kernel-tier component" without claiming API stability.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/assert` `0.0.1`
  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  **Peer dependencies**:

  - `@arki/dot` `^0.1.0`

  Ships together with `@arki/dot@0.1.0`, `@arki/kv@0.1.0`, and `@arki/event-sourcing@0.1.0`.
