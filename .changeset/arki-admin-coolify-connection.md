---
'@arki/admin': minor
---

New `@arki/admin/connections/coolify` entry: a read-only Coolify connection. `createCoolifyClient` is a typed, timeout-bound client (injected `fetch`, explicit base URL and token) with Zod-checked reads for applications, deployments, servers and the installed Coolify version (`probeVersion`). Webhooks are hints: `parseWebhookHint` extracts a hint, `confirmHint` re-reads the Coolify API and only that result becomes a `CoolifySignal` shaped for Foreman's `signals` table. An unverified or spoofed webhook yields no signal.
