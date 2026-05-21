# @arki/kv

## 0.1.0

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  **`@arki/kv`** is the key-value store adapter for the ARKI kernel — the Wave 3 infrastructure layer that plugs into `@arki/dot` via the pip-and-adapter contract. It provides:

  - **Pluggable backend** — embedded (in-memory + on-disk) or remote (Redis/Upstash) drivers
  - **DOT lifecycle integration** — registers as a `cache` pip, contributing to `DotAppManifest.cache` + `DotDiagnosticsSnapshot.cache`
  - **Typed key+value operations** — `get`, `set`, `delete`, `scan` with Zod-validated payloads

  **Why `0.1.x`, not `0.0.x`**: same rationale as `@arki/dot` — adapter layer, experimental but past first integration. `0.1.x` signals "kernel-tier component" without claiming API stability.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  **Peer dependencies**:

  - `@arki/dot` `^0.1.0`

  Ships together with `@arki/dot@0.1.0`, `@arki/db@0.1.0`, and `@arki/event-sourcing@0.1.0`.
