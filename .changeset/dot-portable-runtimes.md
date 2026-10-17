---
'@arki/dot': patch
---

`@arki/dot`, `/plugin`, `/feature`, `/log` and `/test-harness` now run on Node, Bun, Deno, browsers and Hermes. `bun run test:runtimes` proves it.

- Durations use `Date.now()` where the runtime has no `performance` (bare Hermes).
- `hookSignals` reads the global `process` at call time and hooks nothing where there is none. The `SignalTarget` listener type is now `() => void`.
- `./cli` is an adapter entry (Node only). Lint now runs with the shared library preset, and the existing lint errors in the package are fixed.
