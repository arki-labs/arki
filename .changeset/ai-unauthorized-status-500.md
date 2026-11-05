---
"@arki/ai": minor
---

`ai.unauthorized` (the provider rejected the API key) now has status 500 instead of 401. A rejected key is a configuration fault of the app, not a bad request from its caller, so it counts as a fault: spans mark it as an error and an HTTP mapping returns 500. The code and message are unchanged. Migration: code that checked `failure.status === 401` for this failure checks `ProviderUnauthorized.is(failure)` or the code `ai.unauthorized` instead.
