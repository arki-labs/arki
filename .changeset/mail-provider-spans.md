---
"@arki/mail": patch
---

Every `send` and `sendRaw` runs in a `mail.send` span, and every provider request in a `mail.<provider>.send` span under it (`mail.resend.send`, `mail.ses.send`, `mail.cloudflare.send`, `mail.unosend.send`, `mail.mailpit.send`), so a failover shows one span per attempt. Spans carry `mail.transport`, `mail.template`, `mail.provider` and `failure.code` on a failure; only `mail.uncertain` (a fault) sets the error status. Each counts in `mail.operations` (`operation`, `outcome`). Addresses, subjects, bodies and keys are never recorded. `@opentelemetry/api` is a new dependency.

Docs: README `## Observability`.
