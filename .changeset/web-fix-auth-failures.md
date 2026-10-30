---
'@arki/auth': minor
---

`resolveWriteScope` and `reassignScope` return `AccessDenied` (403) for a write the actor may not make and `ResourceMissing` (404) for a move of a row the actor cannot see, instead of throwing `WorkspaceScopeError`, which reached the wire as a 500. `WorkspaceScopeError` stays for bugs in the caller. The handlers `createSignInHandlers` returns now resolve to a `SignInRefused` failure (`data.reason`: `credentials`, `unverified`, `rateLimited` or `unknown`) instead of throwing an `Error` with the server's text; `SignInForm` shows `credentialsError`, `unverifiedError` or `rateLimitedError` from its localization. `SignInFailure` is now derived from the new `SIGN_IN_FAILURE_REASONS` list. `createE2EHandler` answers its refusals with the shared failure envelope (`{ version, code, data? }`). Docs: reference.md updated.
