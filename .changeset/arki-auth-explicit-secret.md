---
'@arki/auth': minor
---

Pass the auth secret only through config, and drop dead and native dependencies (W1-08).

- `betterAuth` no longer writes `process.env.BETTER_AUTH_SECRET`. Each instance keeps its own secret, and two instances with different secrets reject each other's sessions.
- In production, a missing secret or one shorter than 32 characters now throws at startup (`assertAuthSecret`, `AUTH_SECRET_MIN_LENGTH`).
- `@arki/auth/password` now hashes with pure-JS scrypt (`@noble/hashes`) in Better Auth's format, so hashes work in both. Breaking: `comparePasswords(input, hash)` is replaced by `verifyPassword({ hash, password })`, and old bcrypt hashes are not accepted. `bcrypt` is removed.
- `@auth/core` and `@auth/drizzle-adapter` are removed. The Auth.js email types are now local (`EmailProviderConfig`, `EmailProviderUserConfig`, `EmailTheme`).
- `vitest` moves from dependencies to an optional peer, needed only by `@arki/auth/testing/production-boot`. Its `emailModuleMock()` now mocks `createEmailClient`.
- `initAuth` and `ResendProvider` build their email client with `createEmailClient({ isDev, resend: { apiKey } })`.
- New README: install plus recipes for Bun + TanStack Start, oRPC, magic link, workspaces and e2e helpers.
