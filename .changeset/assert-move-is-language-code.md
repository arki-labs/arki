---
'@arki/assert': minor
---

Remove `isLanguageCode` and the `@arki/assert/language` export. It moved to `@arki/intl/language` with the same behavior: import `isLanguageCode` from `@arki/intl/language` instead. `@arki/assert` no longer depends on `is-language-code`; `isURL` and `isBase64` stay.
