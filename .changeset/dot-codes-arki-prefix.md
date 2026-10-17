---
'@arki/dot': minor
---

Breaking: every kernel error now has one stable code in one namespace, `ARKI_DOT_E001` to `ARKI_DOT_E032`, and carries `remediation` and `docsUrl` like `DotPluginError`.

- `DOT_LIFECYCLE_E0nn` is now `ARKI_DOT_E0nn` (same number). `FEATURE_E0nn` is now `ARKI_DOT_E0(21+nn)`: `FEATURE_E001` is `ARKI_DOT_E022`, up to `FEATURE_E010` as `ARKI_DOT_E031`. The constants (`DotLifecycleErrorCode`, `FEATURE_ERROR_CODES`) keep their names, so code that uses them needs no change. Code that matches the old strings must switch to the new ones.
- `DotLifecycleError` and `FeatureError` gain `remediation` and `docsUrl`. New `DotManifestError` (`ARKI_DOT_E032`, still a `TypeError`) replaces the bare `TypeError` from `toJsonObject`.
- The README has an "Errors" table with all codes.
