---
"@arki/auth": minor
---

Breaking: `emailModuleMock` is removed from `@arki/auth/testing/production-boot`. Booting an auth sends no mail, so a production-boot test no longer needs to mock `@arki/mail`. Build the real mail transport with a placeholder key (for example `process.env.RESEND_API_KEY ??= 'test_resend_key'`) and delete the `vi.mock('@arki/mail', ...)` block. A test that checks mail content should send through `@arki/mail/http/mailpit` to a Mailpit container (`@arki/testing/services/mailpit`) and read the mailbox. `assertAuthBoots` and `applyProductionBootEnv` are unchanged, and `vitest` stays an optional peer because `assertAuthBoots` uses `expect`.
