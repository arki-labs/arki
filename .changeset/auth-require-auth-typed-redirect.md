---
'@arki/auth': minor
---

`createRequireAuth` accepts a typed `redirect({ to, search })`, so a guard can send a guest to sign-in with a typed "come back here" `search`. The callback's redirect type was `AnyRedirect`, which refused a typed redirect under `exactOptionalPropertyTypes` when the app's TanStack Router types came from another install than this package's (a linked checkout, another patch release). The redirect's route types are now inferred from the callback. Breaking: `SignInRedirect` takes the redirect's five type parameters (`SignInRedirect<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>`); a bare `SignInRedirect` no longer compiles. Nothing in this repo names it.

no demo impact: drop-studio's guard uses an untyped `redirect({ href })`, which still compiles; it moves to the typed form in its own repo. faultline does not import `@arki/auth`.
