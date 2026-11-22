---
"@arki/testing": patch
---

The public types name no Zod type (`TYPES_E001`). `Timestamp`, `PaginatedResponse` and `Verdict` are plain TS types now, with the same shape as before. The schemas that check them are internal, and a type test locks each schema to its type both ways.

no docs impact: public API unchanged.
no demo impact: no demo reads these types.
