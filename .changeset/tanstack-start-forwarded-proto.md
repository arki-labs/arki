---
'@arki/tanstack-start': patch
---

New `withForwardedProto(request)` on `@arki/tanstack-start/server`. Behind a TLS proxy (`X-Forwarded-Proto: https`), it rebuilds GET and HEAD requests with an `https:` URL, so a locale redirect built from `request.url` (Paraglide's `/` → `/ro`) keeps the browser on HTTPS. Other requests come back unchanged.

no demo impact: server-entry helper with no demo surface.
