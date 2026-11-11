---
"@arki/payments": minor
---

Every caller array in the payments contracts takes at most `MAX_BATCH_ITEMS` (1,000) items; more is `schema.invalid_input`. This covers the dunning segment criteria (`planTier`, `subscriptionStatus`, `customerSegments`, `planTiers`), plan `features`, customer `taxIds`, `metrics`, `requiredTiers`, `targetSegments`, `segmentIds`, `variables`, `unsubscribedChannels`, `campaignIds` and campaign steps. `allowedDays` takes at most 7 days.
