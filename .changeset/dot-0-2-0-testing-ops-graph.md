---
"@arki/dot": minor
---

Testing, operations, and introspection batch (the "beat NestJS where it counts" round):

- `testPip` — typed unit-test builder: compile-checked `.provide()` overrides per need (token or anonymous key), `boot()` won't compile until every need is faked; runs the real kernel underneath.
- `hookSignals(app)` — SIGTERM/SIGINT graceful shutdown: bounded drain via `dispose()`, signal re-raise for standard exit codes, second signal falls through to the runtime default.
- `hookTimeoutMs` (`DOT_LIFECYCLE_E015`) — per-hook watchdog: a hanging `boot`/`start`/`stop`/`dispose` fails loudly with the pip and hook named instead of wedging the app silently.
- `dot explain --graph` / `dot doctor --graph` — the pip graph as Mermaid flowchart source; doctor shows the wiring observed during boot. Composes with `--json`.
