---
'@arki/schedule': minor
---

Nested features: `composeSchedules([parent], scheduler)` and `cronRouterFor` know the schedule names of every feature nested under the ones you pass (`ScheduleNameOf` and `ScheduleValueOf` walk `.features(...)`), and `schedule()` runs each nested feature's schedules once.
