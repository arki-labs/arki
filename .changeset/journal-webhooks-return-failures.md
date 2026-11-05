---
'@arki/journal': minor
---

The webhook sender returns failures for outside input instead of throwing `WebhookError`.

- `subscribe` returns `InvalidInput` (`schema.invalid_input`) when its input fails the schema or the URL is not public https. The issues name the field (`url`, `events`, ...).
- `dispatch` returns `InvalidInput` for input that fails its schema or a payload that is not JSON (a bigint, a cycle), and `journal.webhook_payload_too_large` for a body over `maxPayloadBytes`. Nothing is written for either.
- `replay` returns `journal.webhook_not_found` for an unknown message or subscription and `journal.webhook_other_partner` for a subscription of another partner. `rotateSecret`, `enable` and `disable` return `journal.webhook_not_found` for an unknown id.
- A wrong `encryptionKey` throws `journal.webhook_configuration_invalid` (as `UnexpectedFailure`) when `webhookSender(...)` is built. `dispatch` given the root database throws `invariant` (a caller bug). A non-2xx answer is recorded as `journal.webhook_delivery_failed` and retried by the worker as before.
- `WebhookError` and `WEBHOOK_ERROR_CODES` are removed. `SubscribeInput` and `DispatchInput` are now read from their schemas; their shape is unchanged.
- `journalReceiptStore` (`@arki/journal/foreman`): a claim that loses the insert to a writer outside the journal's append lock now answers `{ claimed: false, receipt }` with the stored receipt. Before, it threw `UnexpectedFailure`.

Upgrade: check the result of `subscribe`, `dispatch`, `replay`, `rotateSecret`, `enable` and `disable` with `isFailure`, or wrap them in `orThrow(...)` where a failure is a bug. Replace `WEBHOOK_ERROR_CODES` matches with the failure codes above.
