---
"@arki/mail": patch
---

`resend`, `mailpit`, `unosend`, `cloudflare` and `ses` check `timeoutMs` when built: a value that is not more than 0 and at most 2,147,483,647 throws `MailError` `ARKI_MAIL_E001`. It used to make every send reject with a raw `TypeError` or `RangeError`.
