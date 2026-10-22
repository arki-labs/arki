---
'@arki/dot': minor
---

`@arki/dot/vite`: a Vite plugin that configures the app while Vite builds. An app that does not configure fails `vite build` instead of the first production request; the manifest and every registered projection document (for example `openapi.json`) are written into the server output. `vite dev` re-checks on every change to the app's module graph. `createAppRuntime` gains `eager`: start the app when the module loads instead of on the first `get()`, for production servers that should boot before they serve.
