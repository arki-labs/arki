---
'@arki/failure': minor
---

Fixes from the first real app that used `@arki/failure`.

- `@arki/failure/orpc` is safe in the browser. It imports `ORPCError` from `@orpc/client` instead of `@orpc/server`. It is the same class, so typed errors still reach the client as `defined: true`. The optional peer dependency is now `@orpc/client`.
- The lint config `configs.recommended` covers TypeScript files only (`**/*.{ts,tsx,mts,cts}`). The `must-use` rule needs type information, so it no longer crashes on plain `.js` files such as `eslint.config.js`.
- `match` takes no `ok` handler when the value can only be a failure, as on the client after `reviveRpcError`. Then the handlers are one per failure code. Passing `ok` there is a type error, like any stale handler. A value that can be a success still needs `ok`.
- The README shows three patterns: a function that returns nothing or a failure, a partial success that keeps its progress with the failure inside the result, and how to choose a status (422 when an upstream service refuses us, 401 only for "not signed in", 503 when an upstream is down).
