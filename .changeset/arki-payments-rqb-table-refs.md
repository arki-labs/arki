---
'@arki/payments': patch
---

The risk-profile, campaign and segment queries that use raw SQL no longer crash with `invalid reference to FROM-clause entry`. `findByRiskCategory`, `findBySegmentId`, `findActiveForTrigger` and `findSegmentsForAutoUpdate` now read columns from the table the query builder hands them. The sorted `findMany` lists of campaigns, executions, communications and segments did the same wrong thing and are fixed too. `findActiveForTrigger` with segment ids also stopped sending the id list as one malformed array. `DunningDatabase` now also accepts a PGlite database.
