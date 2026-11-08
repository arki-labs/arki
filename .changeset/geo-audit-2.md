---
"@arki/geo": patch
---

`calculateMidpoint` and `calculateDestination` always return a longitude within [-180, 180]. Across the antimeridian they could return values such as 181.
