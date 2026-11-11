---
"@arki/auth": patch
---

`IntegrationTester.getUser` documents that it throws `Tester not initialized. Call setup() first.` when called before `setup()`, and a test pins it.
