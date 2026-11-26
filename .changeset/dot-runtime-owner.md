---
"@arki/dot": patch
"@arki/tanstack-start": patch
---

`createAppRuntime` and `startServer` take an `owner`, usually the server entry's `import.meta.url`. A new runtime with the same owner disposes the live app and waits for that before it starts its own. Before, only `import.meta.hot.dispose` did this, and Nitro's dev worker re-runs the entry after an edit without calling it: the old app stayed live beside the new one (a second database pool, a second journal worker), and a journal with workflows refused to compose again (`BAD_DEFINITION ... compose workflows once per initJournal()`), so every request answered 503 until a restart. Pass `owner: import.meta.url` next to `hot: import.meta.hot`. No docs impact beyond `docs/operations.md`, the `startServer` README example and `llms.txt`, which this change updates. No demo impact: no demo has a server entry.

no demo impact: no demo has a server entry.
