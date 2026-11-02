---
'@arki/mail': minor
---

BREAKING: mailOutboxPlugin and mailJobs move from @arki/mail/dot to @arki/mail/outbox; @arki/mail/dot no longer needs @arki/journal. `MailOutboxPluginOptions` moves with them. The README, the agent guide and `llms.txt` name the new entry; `docs/upgrades/0.4.0-to-0.5.0.md` shows the import change.

no demo impact: drop-studio imports only `mail` from `@arki/mail/dot`, whose path does not change; it now loads without `@arki/journal`. faultline uses only the root entry. Neither demo queues mail.
