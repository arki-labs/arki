---
"@arki/auth": patch
---

The README has an `## Observability` section: a table of the `auth.handler`, `auth.principal`, `auth.sign_in_with_id_token` and `auth.observer.<event>` spans, which both the Postgres and SQLite runtimes make. A new test shows `auth.principal` nests under the Dot usecase span that called it. No code change.
