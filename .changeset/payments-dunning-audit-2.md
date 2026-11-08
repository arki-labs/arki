---
"@arki/payments": minor
---

Dunning answers a missing or referenced row with a typed failure, never a raw Postgres error.

- `DunningCampaignRepository.delete` returns `DunningTemplateInUse` for a campaign whose step sent a communication. It locks the campaign and its steps first. Its factory now takes `dunningTemplates` and `dunningCommunications`.
- `DunningTemplateRepository.create` returns `DunningCampaignNotFound` for an unknown `campaignId`. `DunningTemplateRepository.delete` returns `DunningTemplateInUse` for a step that sent a communication (it locks the step first); its factory now takes `dunningCommunications`.
- `DunningExecutionRepository.create` and `DunningCommunicationRepository.create` return the not-found failure of the reference with no row: `DunningCampaignNotFound`, the new `DunningTemplateNotFound` (`payments.dunning_template_not_found`) and `DunningExecutionNotFound` (`payments.dunning_execution_not_found`), or `ReferenceNotFound`. `executeCampaign` and `sendCommunication` pass them on.
- `CustomerRiskProfileRepository.create` and `upsert` return `ReferenceNotFound` (`kind: 'customer'`) for an unknown customer, and never `undefined`. `updateCustomerRiskProfile` and the `DunningIntegrationService` handlers that update the profile pass it on.
- `customer_risk_profiles.customer_id` has a unique index, and `upsert` is one `INSERT ... ON CONFLICT DO UPDATE`: two first upserts at once leave one row. Remove duplicate profiles before pushing the schema.
- `updateCampaign` locks the steps before it checks them for sent communications, so a message written meanwhile cannot turn the refusal into a foreign-key error.
- `handlePaymentSuccess` throws the database error when it cannot cancel an active execution, instead of logging it and resolving.
- A notification provider that cannot be reached throws `PaymentProviderError('unavailable')` instead of a plain `Error`. A message id with a lone UTF-16 surrogate returns `schema.invalid_input`. `sendCommunication` throws an `AggregateError` of both errors when marking the row failed also fails.
- The dunning contracts refuse U+0000 in text and stored JSON, and `stepNumber`, `delayHours` and `updateFrequency` above 2^31 - 1.

See `docs/upgrades/0.5.0-to-0.6.0.md`.
