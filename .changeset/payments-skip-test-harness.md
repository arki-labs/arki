---
"@arki/payments": patch
---

Stop publishing the hostile-input test harness and the test-support helpers. `src/hostile-input/` is used only by tests, but the build compiled it, and its case files pulled `test-support`, `service-test-support` and `stripe-test-support` into `dist/` with sourcemaps that point at unshipped sources. The build and the `files` list now both leave the folder out.

no docs impact: only the published file list in package.json changed.
no demo impact: no runtime file changed, only what the package ships.
