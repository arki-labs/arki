---
'@arki/date': minor
---

Rename the `@arki/date/serialize` entry to `@arki/date/orpc`. It holds the oRPC and SuperJSON codecs, which need optional peers, so it now has a name that says it is an adapter. Replace `from '@arki/date/serialize'` with `from '@arki/date/orpc'`. No alias is left behind.
