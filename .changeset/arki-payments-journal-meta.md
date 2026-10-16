---
'@arki/payments': minor
---

`createCoreJournal`, `createPaymentJournal`, `createSubscriptionJournal` and `createRefundsJournal` take a journal whose meta schema is any Standard Schema with a plain-record output (`StandardSchemaV1<unknown, Record<string, unknown>>`), not only `z.ZodObject`.
