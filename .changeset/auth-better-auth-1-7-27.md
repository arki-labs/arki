---
"@arki/auth": patch
---

`better-auth` and `@better-auth/expo` move from 1.7.10 to 1.7.27. Apps that pin a newer 1.7.x `better-auth` no longer install a second copy next to the one `@arki/auth` uses, so the auth instance types match again.

no docs impact: public API unchanged; no doc names the better-auth version.
no demo impact: no demo depends on `@arki/auth` or better-auth.
