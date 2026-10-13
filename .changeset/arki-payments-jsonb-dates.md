---
'@arki/payments': patch
---

Fix: `CustomerRiskProfileRepository` returns the dates inside its jsonb columns as `Instant`s. `riskScore.lastCalculated`, `paymentHistory.lastPaymentDate` and `engagementMetrics.lastActivity` are typed `Instant`, but Postgres hands jsonb back as ISO text, so a caller that compared or formatted them broke at runtime. Every read now parses them with `instantSchema()`; a write needs no change because an `Instant` serializes to the text that the read accepts.
