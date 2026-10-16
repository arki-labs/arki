---
'@arki/live': minor
---

Scoped hints, endpoint and client half: grants carry keys per dimension, memberships re-authorize a stream, and the client refetches only the queries of the changed keys.

- `liveEndpoint({ hub, manifest, scopes, authorize, reauthorize })`: `authorize` returns `LiveGrant<D>`, `{ tables?, scopes?: { org?: string[] | 'all' } }`, typed by the dimensions of `scopes`. The endpoint builds the stream's `LiveView` from it: per scoped table its dimension and the granted keys, normalized the way Postgres prints the key kind, or `'all'`. A dimension the grant leaves out shows nothing (closed by default). A procedure reading a scoped table stays in the client's manifest when the grant has `'all'` for that dimension, or has keys and the procedure declares `scope` for it; otherwise it is left out, and the endpoint warns once (E001). An undeclared dimension, a key of the wrong kind or over 4 096 keys per dimension is E001.
- `hello.scopes` names the stream's own granted keys.
- `reauthorize: [tableTag(memberships)]`: a frame naming one of these tables runs `authorize` again before it goes out. When the grant changed, or `authorize` refuses or throws, the stream sends `bye` instead, and the client resumes from its last cursor under the new grant. Its tables join the endpoint's tables (they need triggers too).
- `liveQueries` (Dot) takes `scopes`, `reauthorize` and `maxKeys`, and checks the triggers of the scoped and `reauthorize` tables at boot.
- `LiveProvider`: a scoped tag refetches only the queries whose input holds a changed key at the declared path (any form Postgres reads, so an upper-case UUID matches; an input without the key refetches too); a `'session'` path refetches whole. On a `hello` that grants fewer keys, the queries of lost keys are removed from the cache (a `'session'` path whole); on a resume, the queries of gained keys refetch.
- Security: `arki_live.notify_truncate_v1` is now SECURITY INVOKER. Hint payloads travel over NOTIFY, and any role that can connect may LISTEN on any channel, so no trigger publishes a key its caller cannot read. TRUNCATE of a scoped table under row-level security for the truncating role, or by a role that cannot read the key column, sends one overflow: every client resets. Re-run the live migration to replace the function.
- Benchmarks: a scoped-hints strategy (per-tenant grants through the real hub; the run fails above 3.0 origin queries per commit or on a cross-tenant fetch) and a writer group over 1, 1 000 and 100 000 rows with scoped triggers.

Breaking (0.x): `LiveGrant` gains a type parameter and `scopes`; `liveEndpoint` and `liveQueries` take `scopes`; a grant without a dimension no longer sees keyed hints of tables scoped by it.
