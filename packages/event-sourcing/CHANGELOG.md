# @arki/event-sourcing

## 0.1.3

### Patch Changes

- 9871fce: Kernel hardening from external (Codex) review of the v2 DI system:

  - **Lifecycle transitions serialized** — `boot`/`start`/`stop`/`dispose` run on a single transition queue; same-transition calls coalesce (start hooks can no longer double-run), different transitions re-check state at the head of the queue. Fixes a race where `dispose()` completing during a slow `start()` was overwritten by the resuming start, resurrecting a disposed app.
  - **Lazy auto-dispose ownership** — a republished `Lazy<T>` handle is cleaned up only by its first publisher, after that pip's own dispose hook, instead of being closed early by the republisher's record under reverse-order teardown.
  - **Reserved `$` keys enforced** (`DOT_LIFECYCLE_E014`) — `pip()` rejects `$`-prefixed needs aliases and publish keys at compile time; the kernel validates aliases, publish keys, and `rename()` targets at runtime so `$app`/`$pip`/`$config` can never be shadowed.
  - event-sourcing: corrected a stale "reverse-topological order" doc comment (v2 disposes in reverse declaration order).

- Updated dependencies [9871fce]
  - @arki/dot@0.1.3

## 0.1.2

### Patch Changes

- Ship TypeScript source in the npm tarball (`src/**` added to `files`). npm installs and the read-only GitHub mirrors now carry the original `.ts` source alongside compiled `dist/` — better debuggability on the experimental track. No runtime changes.
- Updated dependencies
  - @arki/contracts@0.0.2
  - @arki/log@0.0.2
  - @arki/dot@0.1.2

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
