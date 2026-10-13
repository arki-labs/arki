---
'@arki/queue': patch
---

`@arki/queue/runtime-local`: an array value with an apostrophe in one of its elements no longer breaks the query. The PGlite adapter escaped quotes in every literal except arrays.

`initQueue.create()` no longer reads `process.env.NODE_ENV` when the queue is declared. The `isDev` default is read when it is used, so importing a queue module observes nothing.
