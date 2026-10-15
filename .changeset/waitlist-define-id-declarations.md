---
'@arki/waitlist': minor
---

Export browser-safe id declarations `waitlistEntryId` (`wl_`) and `waitlistReferralCode` (`wlr_`) from the main entry, built with `defineId` from `@arki/contracts`. An app's contract can now validate waitlist ids without restating the prefixes or loading Drizzle.

The server entry builds its columns from the same declarations: `waitlistEntryIdColumns` and `waitlistReferralCodeColumns` hold the column helpers, and `waitlistEntryId` / `waitlistReferralCode` from `@arki/waitlist/server` are now the declarations (`prefix`, `schema`, `create`, `is`). Stored prefixes are unchanged. New ids use the `defineId` generator (the prefix plus 24 lowercase letters and digits). `waitlistEntryIdSchema` / `waitlistReferralCodeSchema` now validate with a template literal (`wl_…` / `wlr_…`); their input type is the id type, not `string`.
