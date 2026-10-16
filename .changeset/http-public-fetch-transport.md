---
'@arki/http': patch
---

`validatePublicURL` and `safeFetchBytes` take `allowCredentials` (`user:pass@` accepted, sent as a Basic `Authorization` header, stripped from the request URL, dropped on a cross-origin redirect; refused by default). The module's top level no longer imports `node:` modules (the resolver and undici load on first use), so the pure checks also load in a browser. `safeFetchBytes` takes `method` and `body` (a redirected POST follows browser rules: 301/302/303 become a bodiless GET, 307/308 replay the body, every hop re-validated) and a `transport` (`lookup` + `fetch`) so a consumer's test can fake the network while the address checks stay real. `systemTransport` is the default.
