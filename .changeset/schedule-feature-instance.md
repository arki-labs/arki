---
'@arki/schedule': minor
---

Feature schedules now work with `feature.instance('eu', rebind)`. A schedule of an instance registers as `<name>#<instance>` (for example `send-digest#eu`), so two copies of one feature no longer clash, and `trigger` and `composeSchedules` use that name. A default lock key follows the qualified name, so each instance has its own lock; a custom `lock` key stays shared. A plain feature keeps its exact names, lock keys and action ids.
