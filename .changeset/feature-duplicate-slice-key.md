---
'@arki/feature': minor
---

`defineFeature` now throws `FeatureError` `FEATURE_E003` when `use` holds two slices with the same key. Before, the second slice silently replaced the first when the feature was plugged into DOT (two `endpoints()` slices kept only the last). Move one slice into its own feature, or merge them.
