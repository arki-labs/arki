# @arki/event-sourcing

## 0.1.1

### Patch Changes

- DOT v2 pip contract — typed dependency injection (BREAKING on the experimental track).

  `pip()` replaces `defineDotPip`: pips declare consumed services as `needs` shapes of type witnesses (`service<T>()` app-local, `token<T>()('key')` cross-package) and hooks destructure them fully typed; provides are inferred from `boot`'s return value. `.use()` is compile-time guarded (unsatisfied needs, type mismatches, wire-key collisions fail at the call site). Declaration order is boot order — the topological sort and name-based `dependencies` are gone; manifest dependency edges are observed from actual wiring. `rename(pip, map, name?)` is the multi-instance primitive, replacing the adapters' silent last-writer-wins `name` options. `lazy(init, { dispose? })` defers expensive opens behind a memoized single-flight `Lazy<T>` handle the kernel auto-disposes; `service.lazy<T>()` lifts eager or lazy providers into a uniform handle. The four `/dot` adapters (`@arki/env`, `@arki/kv`, `@arki/db`, `@arki/event-sourcing`) are migrated to the new contract.

- Updated dependencies
  - @arki/dot@0.1.1

## 0.1.0

### Initial release

- First public publication on npm (experimental track) — 2026-05-21.

  **`@arki/event-sourcing`** is the event-sourcing primitives package for the ARKI kernel — the Wave 3 infrastructure layer that plugs into `@arki/dot` via the pip-and-adapter contract. It provides:

  - **Commands, events, deciders, projections** — the four building blocks for event-sourced aggregates
  - **DOT lifecycle integration** — registers as an `events` pip, contributing to `DotAppManifest.events` + `DotDiagnosticsSnapshot.events`
  - **Type-safe event streams** — Zod-validated event payloads, branded aggregate IDs, deterministic replay

  **Why `0.1.x`, not `0.0.x`**: same rationale as `@arki/dot` — adapter layer, experimental but past first integration. `0.1.x` signals "kernel-tier component" without claiming API stability.

  **Dependencies** (all live on npm at `0.0.1`):

  - `@arki/contracts` `0.0.1`
  - `@arki/log` `0.0.1`

  **Peer dependencies**:

  - `@arki/dot` `^0.1.0`

  Ships together with `@arki/dot@0.1.0`, `@arki/db@0.1.0`, and `@arki/kv@0.1.0`.
