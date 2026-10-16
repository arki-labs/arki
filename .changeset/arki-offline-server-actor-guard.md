---
'@arki/offline': minor
---

Replays send `Offline-Actor` (the user who queued the write), and the `idempotency()` middleware refuses a replay with 403 FORBIDDEN unless it matches the session user. A missing header while signed in is refused. This closes the gap the browser cannot: a session cookie that changes between the queue's own check and the request leaving.
