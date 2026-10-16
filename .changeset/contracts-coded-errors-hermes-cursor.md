---
'@arki/contracts': minor
---

Coded errors and Hermes support. Every deliberate failure is now a `ContractsError` (a `TypeError`) with a stable `ARKI_CONTRACTS_E00n` `code` and a `remediation`; error messages now start with the code instead of `[contracts]`. Keyset cursors no longer use `TextDecoder`, which React Native (Hermes) lacks, so non-ASCII cursors decode there. The package now uses the shared library lint preset and a cross-runtime smoke test.
