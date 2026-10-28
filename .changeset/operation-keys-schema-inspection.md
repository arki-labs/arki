---
"@arki/contracts": patch
"@arki/schema": minor
---

Preserve valid operation keys such as `__proto__` as own enumerable properties in frozen operation trees, including nested keys and JSON serialization.

Schema capability predicates now return `false` when a foreign protocol cannot be inspected. Thrown accessors and revoked proxies cannot escape a predicate. Native promises returned or thrown by accessors are observed once when their constructor/species hooks permit registration, without awaiting them or invoking arbitrary `then` accessors. Provider objects that prohibit handler registration retain ownership of their asynchronous rejection; no provider mutation or global rejection handler is installed. Native validator execution and JSON Schema conversion contracts are unchanged.

No demo impact: the fixes preserve operation identities and safely refuse malformed provider protocols without changing application authoring.
