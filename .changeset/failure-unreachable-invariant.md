---
'@arki/failure': minor
---

Breaking: `assertNever` is renamed `unreachable`, with no alias. Its default message no longer contains the value (it could leak a secret). The error code stays `ARKI_FAILURE_E004`. New: `invariant(condition, message?)` asserts a condition and throws `FailureError` `ARKI_FAILURE_E008`; the message may be a function, built only on failure.
