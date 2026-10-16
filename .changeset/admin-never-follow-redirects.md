---
'@arki/admin': patch
---

The signed Foreman client and `fetchFleetSnapshot` no longer follow redirects. They send `redirect: 'manual'` and treat any 3xx answer as a failure (`ARKI_ADMIN_E016` for the client, `{ ok: false }` for `fetchFleetSnapshot`), so a target cannot bounce Foreman to an internal URL.
