---
'@arki/intl': patch
---

Add `isLanguageCode` to `@arki/intl/language`. It checks a BCP 47 tag such as `en-US` against the language lists and returns the `is-language-code` result (`{ res, message }`). It moved here from `@arki/assert` with the same behavior.
