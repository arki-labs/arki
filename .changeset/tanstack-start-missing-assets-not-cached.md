---
'@arki/tanstack-start': patch
---

`fleetVite()` stops a missing `/assets/*` file from being cached as a 404 for a year.

Nitro serves `/assets` as part of the root public folder, so a missing chunk fell through to the app's not-found page, and that page kept Nitro's `public, max-age=31536000, immutable` header. A CDN then kept the 404 for a year. One deploy swap was enough to break every page's JS.

`fleetVite()` now registers `/assets` as its own Nitro public-asset folder that does not fall through. A missing file gets Nitro's plain 404 with no `Cache-Control`. Production builds only. `nitro` is a new optional peer dependency (types only).
