---
"@arki/testing": patch
---

`mailbox()` checks Mailpit's answers against a Zod schema and throws "Mailpit answered ... with an unexpected shape" when a field it reads has the wrong type, instead of passing the wrong shape on as mail. `zod` moves from a dev dependency to a dependency.
