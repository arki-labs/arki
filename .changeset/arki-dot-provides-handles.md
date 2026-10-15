---
'@arki/dot': patch
---

`feature()` now exposes typed `provides` handles: `billing.provides.entitlements` is a `Token` on the wire key that
billing's `boot` returns, typed from that implementation. A consumer declares `needs: { access: billing.provides.entitlements }`
and never restates the service type. `dot new` templates now pin `@arki/env` 0.0.11, `@arki/db` 0.3.1 and
`@arki/journal` 0.2.1.
