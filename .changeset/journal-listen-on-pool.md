---
'@arki/journal': minor
---

`listenOnPool(pool, channel, { retryMs })`: the wake-channel listener for a `pg` pool, typed by shape so the library imports no driver. It borrows one client while the worker runs, reconnects when the connection drops, and gives the client back on stop. `journal.worker(db, { listen: listenOnPool(db.$client, journal.wakeChannel) })`.
