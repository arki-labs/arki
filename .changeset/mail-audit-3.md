---
"@arki/mail": minor
---

Settings no request can use now fail when the transport, mailer or outbox is built, as `MailError` `ARKI_MAIL_E001`, instead of every send reading as `mail.uncertain` ("the mail may have been sent") or a raw error:

- an `apiKey` (Resend, Unosend), `apiToken` (Cloudflare) or SES `credentials.accessKeyId` / `sessionToken` holding a line break, a NUL character or a character above U+00FF (`fetch` refuses such a header before sending). The message never echoes the key.
- a Mailpit `baseUrl` that is not an http(s) URL without credentials; an empty Cloudflare `accountId` or one with a lone surrogate (was a raw `URIError`); an SES `region` that is not a host name label.
- a `quotaPerMonth` that is not a whole number of at least 0 (NaN silently ignored the budget), and an outbox `maxBytes` that is not a whole number above 0.

Breaking: `send` and `sendRaw` return `MailInvalidMessage` for an `idempotencyKey` holding a line break, a NUL character or a character above U+00FF, on every transport (Resend sends it as a header, and `failover` may pick Resend). Use a Latin-1 key, such as a hash.
