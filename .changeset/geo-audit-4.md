---
"@arki/geo": minor
---

Arguments that are the caller's own constants are checked up front and throw the invariant failure `ARKI_FAILURE_E008`, documented in each JSDoc:

- `precision` in `formatCoordinates` (both entries), `formatCoordinatesWithCardinals`, `roundCoordinates` and `formatBounds` must be a finite number from 0 to 100 (outside that range `toFixed` threw a raw `RangeError`, `NaN` silently meant 0 places, and `roundCoordinates` returned `NaN` past about 308 places). Breaking: a negative `precision` in `roundCoordinates` is refused.
- `bearingToDirection` needs a finite bearing, and `getMarkerColor` a whole index of at least 0 (both returned `undefined` typed as a value).
