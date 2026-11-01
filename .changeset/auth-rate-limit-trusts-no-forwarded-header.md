---
'@arki/auth': minor
---

Rate limits no longer trust a caller-set `x-forwarded-for`. Without `runtime().clientIp`, the engine used to read that header, so a client could send a fresh value on every request and get a fresh sign-in budget each time. Now no request header counts unless the app names one in `clientIp.header`. Without it, the limiter keys on the socket address the runtime puts on the request (`request.ip`, which srvx sets under TanStack Start, Nitro and h3), and when there is none, every caller shares one budget. `signInWithIdToken` gets headers only, so without `clientIp` its callers share one budget. Breaking: an app behind a proxy that relied on `x-forwarded-for` without setting `clientIp` now counts per socket (the proxy) or shared; set `runtime().clientIp.header` to the header your proxy writes. The README claim "a spoofed `x-forwarded-for` cannot pick a new bucket" now holds with and without `clientIp`.

no demo impact: drop-studio already drops `x-forwarded-for` before the handler and requires `CLIENT_IP_HEADER` in production, so it behaves the same; its workaround is removed in its own repo. faultline does not import `@arki/auth`.
