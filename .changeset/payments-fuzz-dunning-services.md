---
'@arki/payments': minor
---

Dunning services return failures instead of throwing: providers, the communication service and the integration service build with `create` and return `payments.configuration_invalid`; list calls return `schema.invalid_input`; `executeCampaign` caps `customerIds` at 1,000.
