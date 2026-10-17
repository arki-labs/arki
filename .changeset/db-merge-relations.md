---
'@arki/db': patch
---

Add `mergeRelations` to `@arki/db/orm`. It joins several `defineRelationsPart(...)` results into one relations config, merging per table, so features can each declare their own relations without losing keys on shared tables. The same relation declared twice throws `DB_COMPOSITION_E004`.
