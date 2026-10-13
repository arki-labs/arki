---
'@arki/journal': minor
---

`replay`, `verify` and `repair` now require a complete history: every version from 1 to the top must be stored, and a row the log says is alive may not be at a higher version than the log. A hole or a row ahead of its log throws the new `JournalError` code `HISTORY_GAP`. Before, a lost middle event folded silently into a wrong row, and `repair` would have saved it.
