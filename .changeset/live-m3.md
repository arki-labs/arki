---
'@arki/live': minor
---

Live queries milestone M3: the client.

- **Opaque cursors (breaking).** A cursor is no longer `${epoch}.${seq}`: the hub seals its position with AES-GCM under a key it makes at `start()`, with a fresh IV every time, so a client cannot count the frames its grant hides. Cursors are 64 base64url characters; `parseLiveCursor` checks only that shape. A well-formed cursor the hub cannot open resets (it is not a 400). The hub needs WebCrypto (`crypto.subtle`); `start()` rejects with E001 without it.
- **Hub (breaking).** `LiveHub.open()` now returns a promise (it opens the cursor first). New `hub.cursor()`: the current position as a new cursor, for a server-rendered page to dehydrate.
- **`createLiveClient`** in `@arki/live`: `fetch` + streaming body + streaming `TextDecoder`, framed by hand (split chunks and code points, CR/LF, `:keepalive`, `event: error`); `bye` reconnects at once with the cursor, `gap` and errors back off (250 ms to 10 s, jittered; a 503 waits its `retry-after`), 401/403 stop as `unauthorized`, 400 drops the cursor, a fetch without a streaming body fails loud (E004). New types `LiveClient`, `LiveClientOptions`, `LiveStatus`.
- **`@arki/live/react`** (new entry): `LiveProvider`, `useLiveQuery(orpc.x.queryOptions({ input }))`, `useLiveStatus`, `setLiveCursor` (server rendering resumes from the hub cursor instead of resetting) and `awaitTxId(queryClient, txid, { timeoutMs })`. A hint during a query's first fetch is not lost (one trailing refetch); 401/403 is not retried and resets a query once, with no refetch loop; `initialData` is a type error; paths that leave the manifest are dropped from the cache; a hook on a procedure not in the manifest logs E001 once.
- **`@arki/live/testing`**: `waitForInvalidation(queryClient, path, timeoutMs?)`.
