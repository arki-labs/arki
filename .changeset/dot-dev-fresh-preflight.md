---
'@arki/dot': patch
---

`dot dev` runs every preflight in a fresh process (hidden `dot _preflight`, same runtime and env as the runner) and reads back one JSON report: the plugin counts, the migrations the boot applied, and the doctor verdict or failure. A restart now checks the app file and env as they are now, not the module cached at the first import, and the supervisor never configures the app itself. A preflight process that crashes, hangs past `preflightTimeoutMs` (default 120 s) or prints no valid report fails with `dot.dev_preflight_failed` (`DevPreflightFailed`); stopping `dot dev` kills it.
