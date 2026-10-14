---
'@arki/testing': patch
---

Replace the `"./*"` wildcard export with one explicit entry per module: `assertions`, `containers`, `debug`, `factories`, `integration-tester`, `msw`, `performance`, `tester-builder`, `timestamps`, `types` and `vitest-setup`. Every existing import specifier still resolves.
