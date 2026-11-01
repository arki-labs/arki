---
'@arki/auth': minor
---

`createSignInHandlers(createAuthClient(definition), ...)` compiles in an app with `exactOptionalPropertyTypes`. The form adapter declared its own copy of the engine's result type (`error.code: string | null`), and the engine client returns `code?: string | undefined`. The adapter now takes the `error` type from the client `createAuthClient` returns, so the two cannot drift. Breaking: `SignInCapableAuthClient` is now exact: each method resolves to `{ error }` where `error` is `null` or the engine's error (`status`, `statusText`, `code?`, `message?`). A hand-written client must return that shape; the real engine client does.

no demo impact: drop-studio writes its own sign-in form and does not call `createSignInHandlers`; it moves to `SignInForm` in its own repo. faultline does not import `@arki/auth`.
