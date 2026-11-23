---
'@arki/auth': minor
---

Add a fresh-session check for risky actions. `sessions.freshFor` (seconds) in `defineAuth` sets how long a session counts as fresh after sign-in; the engine's delete-account, unlink-account and list-sessions routes follow it too (unset: the engine's default of 1 day). The new `freshSession` step is used like `authed`: a guest gets `auth.unauthenticated`, an older session gets the new `SessionNotFresh` failure (`auth.session_not_fresh`, 403, data `{ freshFor }`), part of `AUTH_FAILURES`. A sign-in that succeeds on a request carrying the same user's session now revokes that session, so a re-check leaves one session. The principal carries `freshFor` when it is set.
