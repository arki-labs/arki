---
"@arki/auth": minor
---

Add passkey sign-in. List `'passkey'` in `defineAuth({ methods })` with `passkey: { rpName }` (required with the method, refused without it); the relying party id and the expected origin come from `runtime.url`. Build the table with the new `createPasskeyTables(c, { fill, user, ids })` from `@arki/auth/pg` and `@arki/auth/sqlite`, and pass it with the other tables; boot refuses `passkey` without it (`ARKI_AUTH_E007`). `authIdSources` gains `passkey`, and `passkeyIdColumns`, `PasskeyId`, `createPasskeyId` and `passkeyIdSchema` are new. The client from `createAuthClient` gains `signIn.passkey`, `passkey.addPasskey`, `passkey.listUserPasskeys` and `passkey.deletePasskey`, typed from the definition, and `capabilities.passkey`. A passkey sign-in counts as a fresh sign-in for `freshSession`, and one made on a request with the same user's session replaces that session.
