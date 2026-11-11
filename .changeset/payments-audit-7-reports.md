---
'@arki/payments': minor
---

Batch methods return each failure as a value, never only as a log line or its text.

- Breaking: `PaymentRetryService.processRetries()` returns one report per due attempt, in run order (it returned `void`): `{ attemptId, status }` with `status` `succeeded`, `failed` (`failure` is the declined card, `payments.card_declined`, or `payment` is the provider's answer that did not succeed), `cancelled`, `refused` (`failure` is what the provider or the journal returned, such as `payments.configuration_invalid` from a `StripeProvider` built without `references`), or `thrown` (`error`). An attempt that an earlier attempt of the same run recovered is `cancelled` and no longer charged again.
- Breaking: `WebhookHandler.retryFailedWebhooks()` returns one report per event read (`processed`, `skipped`, `refused` with `failure`, `thrown` with `error`; it returned `void`). A fault that stops the whole run still emits `webhook:retry_error` and is now thrown instead of swallowed.
- Breaking: a `DunningTickReport.failed` entry is `{ id, status: 'refused', failure }` or `{ id, status: 'thrown', error }` (it was `{ id, code, message }`, with `code: null` and only the message for a thrown error). `DunningTickFault` is inferred from `tickFault`.
