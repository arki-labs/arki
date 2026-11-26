---
"@arki/fs": patch
"@arki/mcp": patch
"@arki/offline": patch
---

oRPC moves to 1.16.5 and TanStack Query to 5.108.2, the versions the apps already run. The whole oRPC family is now pinned exactly: `@orpc/openapi` pins its siblings exactly, so a `^` range on the others let them float to 1.16.6 and installed a second copy of `@orpc/server`, `@orpc/client` and `@orpc/contract` beside it. No docs impact: no API changed. No demo impact: demos take the same catalog.

no docs impact: no API changed, only dependency versions moved.
no demo impact: demos take the same catalog.
