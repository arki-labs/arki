---
"@arki/auth": minor
---

New entry `@arki/auth/testing/integration-tester`: `IntegrationTester`, `initTester` and their types (`TestUser`, `TestUserRole`, `TesterOptions`, `TesterUsers`, `TesterUserOverrides`, `TesterDatabase`, `IntegrationTesterConfig`, `CreateCallerArgs`, `TesterBuilder`, `TesterConfig`, `ContextTesterBuilder`, `InitialTesterBuilder`). They moved here from `@arki/testing/server/integration-tester` and `@arki/testing/server/tester-builder`, unchanged, because their test users carry an auth `UserId`. Change the import path only. The entry needs the new optional peers `@arki/testing`, `testcontainers` and `@testcontainers/postgresql`, and Docker unless a global connection string is set.

Docs: README `## Public imports` and `## Documentation`, new `docs/integration-tester.md`, `docs/agent-guide.md`.
