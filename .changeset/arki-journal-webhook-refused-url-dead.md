---
'@arki/journal': patch
---

Outgoing webhooks: a delivery whose URL `publicFetch` refuses (`UnsafeUrlError`, such as a host that now resolves to a private address) is dead on its first try, whatever `retry` allows. It is refused the same way every time, so retrying it only filled `webhook_attempts`. It still counts toward `disableAfter`.
