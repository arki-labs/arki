---
'@arki/money': patch
---

Faster `allocate`: whole-number ratios skip decimal parsing, parts are computed with plain number arithmetic while they stay safe integers, and the largest-remainder sort is skipped when every remainder is equal (about 2× faster for `allocate([1, 1, 1])`).
