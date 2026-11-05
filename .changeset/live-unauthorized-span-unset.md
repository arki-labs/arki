---
"@arki/live": patch
---

The live client span for the `unauthorized` end reason (401 or 403 from the stream) no longer has an error status. A refused session is an expected outcome, so the status stays unset; the `live.client.outcome` attribute still says `unauthorized`. `retry` and `error` end reasons keep the error status.
