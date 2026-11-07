---
"@arki/admin": patch
---

A Foreman private key of the right length whose bytes are not an Ed25519 PKCS#8 key now fails with `ARKI_ADMIN_E014` (invalid config) on first use, with the crypto error as `cause`. Before, the first call rejected with a raw `DOMException`.
