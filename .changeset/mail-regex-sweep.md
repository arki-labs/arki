---
"@arki/mail": patch
---

`mailSink().sentTo` reads each address in one pass. An address with a long run of `<` and no `>` made it read on from every `<`. It finds the same mailbox as before.
