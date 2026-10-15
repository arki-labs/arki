---
'@arki/kv': patch
---

`kv.optional(options)` in `@arki/kv/dot`: the same plugin as `kv()` for apps where Redis is optional. With no URL it publishes `kv` as `null` and opens no client instead of failing boot; with a URL it opens the same client, and `dispose` closes it. The published type is `KV | null`. Both variants also take `probe: true` (with `probeTimeoutMs`, default 5000): a set/get/delete round trip at boot, so a bad or unreachable URL fails boot with `ARKI_KV_PLUGIN_E002` instead of the first request. `kv()` without `probe` behaves as before.
