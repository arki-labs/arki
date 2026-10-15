---
'@arki/waitlist': minor
---

Export the waitlist's result shapes as browser-safe zod schemas from the main entry: `waitlistSignupResultSchema`, `waitlistReferralSummarySchema`, `waitlistStatusResultSchema`, `waitlistEntrySchema`, `waitlistEntryStatusSchema` and the `WAITLIST_ENTRY_STATUSES` tuple. An app's contract can use them as output schemas instead of restating the shapes.

The package's types are now read off these schemas, so each shape is written once: `WaitlistSignupResult`, `WaitlistReferralSummary`, `WaitlistStatusResult`, `WaitlistEntryRow` and `WaitlistEntryStatus`. `WaitlistEntryRow` and `WaitlistEntryStatus` are also exported from the main entry now; `@arki/waitlist/server` still re-exports them. Optional fields read as `field?: T | undefined`.
