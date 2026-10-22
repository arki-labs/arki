---
'@arki/dot': patch
'@arki/auth': patch
'@arki/schedule': patch
'@arki/ui': patch
'@arki/contracts': patch
'@arki/tanstack-start': patch
---

Go to Definition works on mapped keys again. Handle maps (`unit.provides.x`, feature handles), `PolicyTree`, `SessionValues`, `CronPolicy.respond`, `ChartConfig.theme`, `Operations` and the oRPC utils tree now map `[K in keyof T as K & string]` instead of `[K in keyof T & string]`. The old form cut the link from each key back to its declaration, so the editor found no definition. Types are otherwise unchanged.
