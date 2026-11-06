---
'@arki/testing': minor
---

`@arki/testing` renames five export entries so the layers check treats them as adapter entries. Only the import path changes. Every exported name stays the same.

- `@arki/testing/e2e` is now `@arki/testing/playwright`.
- `@arki/testing/ai/playwright` is now `@arki/testing/playwright/ai`.
- `@arki/testing/services/mailpit` is now `@arki/testing/containers/mailpit`.
- `@arki/testing/services/postgres` is now `@arki/testing/containers/postgres`.
- `@arki/testing/services/redis` is now `@arki/testing/containers/redis`.
