---
"@arki/string": minor
---

Remove `tryFromBase64`; use `fromBase64` with the same options and exact returned failures. Remove obsolete E002/E003 codec diagnostics from `STRING_ERROR_CODES` and its inferred `StringErrorCode`; E001/E004 static misuse remains. Upgrade guidance and Hyphenate's caller are migrated.

no demo impact: no demo imports the removed exports; the Hyphenate app import is updated with unchanged decoding behavior.
