---
'@arki/tanstack-start': minor
---

`@arki/tanstack-start/vite` gains three build-time helpers: `reactCompiler()` runs the React Compiler on every component and hook (Babel plugin through `@rolldown/plugin-babel`); `zodCompiled()` makes every Zod schema the server constructs parse through a compiled validator by loading `zod/compile` first in the server bundle; `oneChunkPerRoute` is the `codeSplittingOptions` that keeps a route's loader in the route's own chunk instead of the entry.
