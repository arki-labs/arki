---
'@arki/http': patch
---

`fetchAllowedHosts()` in `@arki/http/public-fetch`: the env variable `FETCH_ALLOW_HOSTS` (comma-separated `host:port`) lists hosts the public-fetch guard lets through even at a private or loopback address, so an end-to-end test can fetch from a local fixture server. Any other private address is still refused, and it throws when `NODE_ENV=production`, so it can never open the guard in a deployment.
