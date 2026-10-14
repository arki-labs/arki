---
'@arki/testing': minor
---

`import '@arki/testing'` no longer needs Docker, msw or `@arki/auth`. The root now holds only factories, assertions, timestamps, debug and performance helpers. `initTester` moved to `@arki/testing/tester-builder`. `IntegrationTester` and the tester types (`TestUser`, `TesterUsers`, `TesterOptions`, `IntegrationTesterConfig`) moved to `@arki/testing/integration-tester`. `setupGlobalTestContainers` and the container helpers moved to `@arki/testing/containers`. The `./types` entry is gone. `@arki/auth`, `testcontainers`, `@testcontainers/postgresql`, `@testcontainers/redis` and `msw` are now optional peer dependencies; install the ones the entries you use need.
