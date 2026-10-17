---
'@arki/log': minor
---

`configure(config, { owner })`: an app entry can now run again in the same process without `ARKI_LOG_E001`. Nitro's dev worker re-imports the server entry after an edit and never runs `import.meta.hot` dispose hooks, so the second `configure()` threw and every page returned 500. When both calls pass the same `owner` (use `import.meta.url`), the second call replaces the setup, closes the old sinks, and makes the old handle stale. Any other second `configure()` still throws `ARKI_LOG_E001`. New type: `ConfigureOptions`.
