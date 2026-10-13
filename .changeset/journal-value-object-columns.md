---
'@arki/journal': minor
---

The write check compares value objects with their own `equals`. A class instance with an `equals` method, such as a Temporal `Instant` or `PlainDate` from an `@arki/db/temporal` column, now writes when the column stores it exactly. Before, every class instance other than `Date` was a `VALUE_MISMATCH`, so entity tables could not hold Temporal values. A value the column changes is still refused.
