---
'@arki/live': patch
---

`reauthorize`: a write to a `reauthorize` table that lands while a stream opens (after its `authorize` read the grant, before the stream joins the endpoint's re-check list) now re-checks that stream before its first frame (`hello` included); before, the stream served the old grant until the next such write or `maxAgeMs`.

`close()` now fails closed: a stream still opening when the endpoint closes ends at once instead of joining unwatched, and every open stream gets `bye` (as documented) so clients reconnect.
