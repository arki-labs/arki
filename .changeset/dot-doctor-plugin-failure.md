---
'@arki/dot': patch
---

`dot doctor` now shows why a plugin failed to boot. The `ARKI_DOT_E003` issue keeps its code, its message ends with the plugin's own failure message, and `metadata.failureCode` carries the plugin's failure code. This adds fields only.

no demo impact: the drop-studio and faultline `dot doctor` captures boot cleanly, so no issue text changes there.
