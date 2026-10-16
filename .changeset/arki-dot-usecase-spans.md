---
'@arki/dot': minor
---

Every usecase from `defineFeature(...).usecases(...)` now runs in an OpenTelemetry span named `feature.<feature>.<usecase>`. A returned `@arki/failure` failure sets the span status to ERROR with `failure.code` and `failure.status`, and records no exception. A throw or rejection is recorded as an exception, sets ERROR, and is rethrown unchanged. Anything else sets OK. The span is active, so spans started inside the usecase nest under it. With no SDK registered, calls go straight through with the same `this`, arguments and return value. Usecase types do not change. `rpc()` adds no span: oRPC's own `call_procedure` span covers each procedure once `@orpc/otel` is registered. `@arki/dot` now depends on `@arki/failure`.
