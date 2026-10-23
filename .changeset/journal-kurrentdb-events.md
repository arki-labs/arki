---
'@arki/journal': minor
---

Events in KurrentDB: `kurrentEvents({ client, prefix? })` from the new `@arki/journal/kurrentdb`, with `@kurrent/kurrentdb-client` as an optional peer.

- One entity is one stream, `<kind>-<entityId>` (a kind must not contain `-`). `prefix` puts all of the log's streams under one name.
- The event's type and data are KurrentDB's fields; the rest of the journal event is in its metadata under `journal`. Event ids are UUIDv5s of the journal ids, so a retried append repeats them.
- Appends use the stream's expected revision. A repeat KurrentDB does not recognise is read back and acked.
- `all` reads `$all` (commit order), with `"commit:prepare"` positions. `forget` is refused: KurrentDB cannot rewrite an event.
