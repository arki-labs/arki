---
'@arki/bench': minor
---

Choose the Node you measure on, and know when it is the wrong one. `--node <path>` (or `ARKI_BENCH_NODE`) sets the Node binary for the Node leg; the default is the Node running `arki-bench`. When the project declares a Node version (`.nvmrc`, `.node-version`, `volta.node` or `engines.node`, found by walking up from the bench file) and the Node that ran does not meet it, the result gets a blocking `node-version-mismatch` warning naming both versions, so it is marked NOT PUBLISHABLE. A `--node` path that does not exist is a `runtime-missing` warning.
