---
'@arki/admin': patch
---

`createCoolifyEnvWriter` writes environment variables to a Coolify application, runtime-only, literal and outside previews, with `secret` entries shown once. It stores a probe variable first and checks Coolify kept it runtime-only, so a Coolify that would store a key build-time never receives a real value. It never reads values back or puts a body in an error or a log line. Docs: the Coolify connection README has an "Env writer" section. No demo impact: the Coolify connection has no demo.
