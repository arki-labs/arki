---
'@arki/auth': minor
---

Rate limits no longer trust a caller-set `x-forwarded-for`. Without `runtime().clientIp`, the engine used to read that header, so a client could send a fresh value on every request and get a fresh sign-in budget each time. Now no request header counts unless the app names one in `clientIp.header`. Without it, the limiter counts on the socket address the runtime puts on the request (`request.ip`, which srvx sets under TanStack Start, Nitro and h3); without one, on the target account (the body `email`, or the signed-in user), so one client's failures lock out only that account, never everyone; only sign-up and anonymous calls, which have no account, share one key. The account key reaches the engine as a private IPv6 address derived from a SHA-256 of the account (the engine takes only an address), and a session made that way records no address.

New boot code `ARKI_AUTH_E009` (`clientAddressRequired`): production with the `password` method and no `clientIp` refuses to boot, because sign-up would share one budget; the message says to set `runtime().clientIp`. Development boots and logs one warning. `signInWithIdToken` takes a new `clientAddress` for an address the caller trusts (the socket, its own proxy); without it and without `clientIp`, id-token sign-ins share one budget.

Breaking: an app with `password` that runs in production without `clientIp` no longer boots; set `runtime().clientIp.header` to the header your proxy writes. An app behind a proxy that relied on `x-forwarded-for` without `clientIp` now counts per socket (the proxy) or per account. The README claim "a spoofed `x-forwarded-for` cannot pick a new bucket" now holds with and without `clientIp`.

no demo impact: drop-studio already requires `CLIENT_IP_HEADER` in production, so it boots as before; its own `x-forwarded-for` stripping is removed in its own repo. faultline does not import `@arki/auth`.
