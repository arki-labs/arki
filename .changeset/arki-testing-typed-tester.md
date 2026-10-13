---
'@arki/testing': minor
---

`initTester` no longer erases types. `tester.db` and `tester.repo` now have the types of the functions you pass to `create`: the database type comes from the parameter of `createRepositories`, the repository type from its return value, and the schema type from `schema`. Before, they were `any` in every app test.

Breaking: `TesterConfig` now takes `<TSchema, TDatabase, TRepositories, TContext, TCaller>` (it is `IntegrationTesterConfig` with the context and caller moved last). `TesterBuilder['create']` is generic over those three inferred types. Type the `db` parameter of `createRepositories` if your tests need a narrower database type than the default.
