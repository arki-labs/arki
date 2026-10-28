---
'@arki/string': minor
---

Return canonical MissingValue failures from interpolation and its fluent wrapper instead of throwing for absent runtime values. Rename missing: throw to missing: fail, remove the retired E005 diagnostic, and preserve explicit keep/empty recovery. Failure metadata contains no template or supplied values.

Upgrade guidance and package examples cover result narrowing. No demo impact: no demo interpolation caller was found in the source audit.
