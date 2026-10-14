---
'@arki/math': patch
---

List the number-words locales as explicit entries (`./words/de`, `./words/es`, `./words/fr`, `./words/it`, `./words/ro`) instead of a `./words/*` wildcard, so a new file under `src/words/` is never published by accident. Import paths are unchanged.
