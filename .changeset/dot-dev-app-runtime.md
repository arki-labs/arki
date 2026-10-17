---
'@arki/dot': minor
---

New entry `@arki/dot/runtime`: `createAppRuntime(app, { hot: import.meta.hot, onStarted })` keeps one started app per server process, also under Vite hot updates. `get()` starts the app once and retries a failed start. On a hot update the old app is disposed, and the replacing module starts its app only after that disposal finished, so two apps never hold the same pool or PGlite directory (`import.meta.hot.dispose` alone does not wait). The started app is hooked to SIGTERM / SIGINT with `hookSignals`. The `dot new` stack template and the monorepo app template use it.
