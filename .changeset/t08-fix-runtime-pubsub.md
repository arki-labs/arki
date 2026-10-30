---
'@arki/pubsub': patch
---

A subscriber that returns a rejecting promise no longer becomes an unhandled rejection: it is logged at warn like a throwing one, on every backend. SQLite poll failures and Redis subscriber connection errors are logged at warn instead of debug.
