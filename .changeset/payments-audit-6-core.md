---
'@arki/payments': minor
---

Audit 6, core lane. Id schemas, `userIdSchema` included, refuse an id longer than the id column (256 characters) as `schema.invalid_input`, and `PaymentRepository` lookups answer such an id as not found without a query. `PaymentRetryService.updateRetryStrategy` returns the new failure `payments.retry_strategy_not_found` for an unknown name. JSON for a jsonb column may nest at most 100 levels (`MAX_JSON_DEPTH`); deeper is `schema.invalid_input`. New `taxRecordIdSchema` and `taxAuditEntryIdSchema`.
