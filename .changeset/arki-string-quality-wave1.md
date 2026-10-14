---
'@arki/string': minor
---

Breaking: every deliberate failure is now a `StringError` with a stable code (`ARKI_STRING_E001` to `E005`, exported as `STRING_ERROR_CODES`, subpath `@arki/string/errors`) and a `remediation`. It replaces the built-in `TypeError`, `RangeError`, `SyntaxError` and `ReferenceError` these functions threw. Match on `error.code`.
