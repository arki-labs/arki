---
'@arki/live': minor
---

Two leaks fixed, before the scoped-hints work.

- The grant now applies inside the hub, before each stream's own batch window, queue and frame split. `liveEndpoint` passes it as `hub.open({ grant })`. A hint with no granted table no longer reaches the stream at all, so hidden writes can no longer cause a slow client's `bye`, change its frame count, close its window early (the 256-transaction flush) or shift when its frames arrive. Each stream now batches its own visible hints; a resume replays the missed hints through the same grant and windows. The ring holds one hint per source change, and the `replayFrames` default is now 262 144.
- Frames carry receipts instead of raw Postgres transaction ids, which showed the database-wide write volume. `liveReceipts({ app, secret })` makes `base64url(HMAC-SHA256(secret, "arki-live/v1|" + app + "|" + xid8))` cut to 22 characters; pass it as `createLiveHub({ receipts })` (or `liveQueries({ receipts })`) and return `await receipts.of(txid)` from mutations. `awaitTxId(queryClient, receipt)` matches by equality as before. The secret comes from the app config (at least 32 characters, e.g. `openssl rand -base64 32`); `liveReceipts` throws E001 for a shorter one or without WebCrypto. Without `receipts`, frames carry `txids: []`.

Breaking (0.x): the wire `change.txids` holds 22-character receipts (old clients reject the new frames); `LiveFeed`'s `change` loses `txidsByTag`; `LiveGrant` moves to the core (still exported from `@arki/live/http`). New: `liveReceipts`, `LiveReceipts`, `LiveReceipt`, `LiveGrant` from `@arki/live`, `open({ grant })`, `createLiveHub({ receipts })`, `liveQueries({ receipts })`.
