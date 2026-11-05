---
"@arki/testing": minor
---

New entry `@arki/testing/otel` with `captureSpans()`. It installs an in-memory tracer provider and meter
provider as the OpenTelemetry globals for one test (plus an `AsyncLocalStorage` context manager when none
is registered) and returns `finished`, `named(name)`, `childrenOf(span)`, `collectMetrics()`, `reset()`
and `[Symbol.dispose]`, so `using spans = captureSpans()` restores the earlier providers. Each captured
span carries its finished `parent`. `@opentelemetry/sdk-trace-base` and `@opentelemetry/sdk-metrics` are
new dependencies; `@opentelemetry/api` is an optional peer.

Docs: `docs/otel.md`, README public imports, failure and limits lines, agent guide task.
no demo impact: test tooling, no demo uses it.
