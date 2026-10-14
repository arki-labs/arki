---
'@arki/math': minor
---

Every error class now carries a stable `code` (`ARKI_MATH_E001` to `E011`, exported as `MATH_ERROR_CODES`) and a `remediation` string. `MathError` is now abstract; catch it with `instanceof` as before.
