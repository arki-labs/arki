---
"@arki/tanstack-start": patch
---

Publish `src/` next to `dist/`. The `.js.map` files point at `../../src/*.ts`, which were missing from the package, so Vite printed "Sourcemap points to missing source files" for every module it loaded. Test files and fixtures stay out of the package.

No docs impact: only the published file list changed. No demo impact: no runtime file changed.
