---
"@arki/intl": minor
---

`loadMessagesFromMultipleDictionaries` returns a `DictionaryLoadFailed` failure (`intl.dictionary_load_failed`, the cause attached) instead of rejecting when a dictionary chunk fails to load or a feature loader rejects. Check the result with `isFailure` or `orThrow` from `@arki/failure`. `@arki/failure` is a new dependency.
