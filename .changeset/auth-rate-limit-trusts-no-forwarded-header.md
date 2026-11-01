---
'@arki/auth': minor
---

Rate limits no longer trust a caller-set `x-forwarded-for`. Without `runtime().clientIp`, the engine used to read that header, so a client could send a fresh value on every request and get a fresh sign-in budget each time. Now no request header counts unless the app names one.

`runtime().clientIp` is `{ header: '<name>' }` (the one header your proxy writes) or, new, `{ from: 'socket' }` (the socket address the runtime puts on the request, `request.ip`, which srvx sets under TanStack Start, Nitro and h3). One or the other, never both: boot checks it against its schema (`ARKI_AUTH_E001`). New type `ClientIpSource`.

Without `clientIp`, the limiter counts on the socket address; without one, on the target account: the signed-in user first, else the body `email` only on `/sign-in/email`, `/request-password-reset` and `/sign-in/magic-link`, the endpoints whose account is that email. So one client's failures lock out only that account, and a varying email on any other endpoint buys nothing. Anything else shares one key. The account key reaches the engine as a private IPv6 address derived from a SHA-256 of the account, a deliberate workaround: the engine takes only an address as its key, and a second limiter would copy its rules. A session made that way records no address.

New codes: `ARKI_AUTH_E009` (`clientAddressRequired`): production without `clientIp` refuses to boot, for every method, since each creates accounts or mails an address the caller picks; either form satisfies it. `ARKI_AUTH_E010` (`socketAddressMissing`): with `{ from: 'socket' }`, production refuses a request that has no socket address, and an id-token sign-in without `clientAddress`; the socket is visible only per request, so this cannot fail at boot. Development without `clientIp` boots and logs one warning. `signInWithIdToken` takes a new `clientAddress` for an address the caller trusts.

Breaking: production without `runtime().clientIp` no longer boots; set `{ header }` behind a proxy or `{ from: 'socket' }` without one. An app behind a proxy that relied on `x-forwarded-for` without `clientIp` now counts per socket (the proxy) or per account. The README claim "a spoofed `x-forwarded-for` cannot pick a new bucket" now holds with and without `clientIp`.

no demo impact: drop-studio already requires `CLIENT_IP_HEADER` in production, so it boots as before; its own `x-forwarded-for` stripping is removed in its own repo. faultline does not import `@arki/auth`.
