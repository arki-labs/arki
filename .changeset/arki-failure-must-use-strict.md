---
'@arki/failure': minor
---

`failure/must-use` is stricter. It now reports a discarded `Promise.all` or `Promise.allSettled` whose items can be failures (the result is an array, so the old check missed it), and `void` is no longer an opt-out: `void (await remove(id))` is reported too. The only deliberate discard left is `// eslint-disable-next-line failure/must-use -- <reason>`. This can break lint in code that used `void` to drop a failure.

New rule `failure/no-blind-accept`, on in `configs.recommended`. It reports `accept(r)` (or `ctx.accept(r)`) when `r` was not checked by kind: `if (isFailure(r)) accept(r)` and an unchecked `accept(r)` are reported; `if (OutOfStock.is(r)) accept(r)` and `if (OutOfStock.is(r) || Busy.is(r)) accept(r)` pass. The checked call names are set with `names` (default `['accept']`). This can break lint in code that accepts any failure.
