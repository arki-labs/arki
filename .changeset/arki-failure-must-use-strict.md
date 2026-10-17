---
'@arki/failure': minor
---

`failure/must-use` is stricter. It now reports a discarded `Promise.all` or `Promise.allSettled` whose items can be failures (the result is an array, so the old check missed it), and `void` is no longer an opt-out: `void (await remove(id))` is reported too. The only deliberate discard left is `// eslint-disable-next-line failure/must-use -- <reason>`. This can break lint in code that used `void` to drop a failure.
