---
'@arki/admin': minor
---

A module can declare its own errors. `moduleError(code, status, message, remediation)`, `ModuleError` and `isModuleError` (from `@arki/admin/module`) build a coded 4xx refusal. The dispatcher answers it with the module's own status and code, the client reads them back, and a failed receipt keeps them, so admin never learns a module's concepts. A status outside 400 to 499 is `ARKI_ADMIN_E014`. `redactSecrets` now lives in `@arki/admin/module` (it moved from `@arki/queue/foreman`).

Breaking (0.x): the wire error `code` and the receipt `code` are now strings (an admin code or a module's own), no longer a closed list. The `./pg` entry is removed, with the `@arki/journal` and `drizzle-orm` dependencies: `journalReceiptStore` and `foremanReceiptTables` are now exported from `@arki/journal/foreman`.
