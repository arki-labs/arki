---
"@arki/geo": minor
---

Breaking: `parseCoordinates` from `@arki/geo/maps/google` is now the core parser. It returns `InvalidCoordinates` with a reason for bad text instead of `null`, and no longer accepts `"12abc, 5"`. Check the result with `InvalidCoordinates.is(result)` instead of `result === null`.
