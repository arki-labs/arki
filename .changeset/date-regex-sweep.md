---
"@arki/date": patch
---

`parseISO` reads the offset part of a time in one pass. Time text with many `Z`, `+` or `-` signs and a line break at the end made it read to the end again from each sign: seconds per 100 KB. It accepts and rejects the same text as before.
