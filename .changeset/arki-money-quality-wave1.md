---
'@arki/money': minor
---

Money-only errors carry stable codes `ARKI_MONEY_E001` to `E004` (exported as `MONEY_ERROR_CODES`) and a `remediation`. Breaking: `UnknownCurrencyError.code` held the bad currency text; that is now `currencyCode`, and `code` is the stable error code. `MoneyError` is now abstract.
