---
"@arki/admin": patch
---

Each approved Foreman execute runs in an `admin.action.execute` span with `admin.action`, `admin.receipt` (`applied`, `failed`, `pending`, `replayed` or `unclaimed`) and `failure.code` on a failure, and counts in `admin.executions` (`action`, `receipt`, `outcome`). Served through `foreman()` it nests under the request's `http.request` span. The input, result, execution id, approver and keys are never recorded. `@opentelemetry/api` is a new dependency.

Docs: README `## Observability`.
