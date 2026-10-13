---
'@arki/testing': minor
---

`initTester` no longer erases types. `tester.db` and `tester.repo` now have the types of the functions you pass to `create`: the database type comes from the parameter of `createRepositories`, the repository type from its return value, and the schema type from `schema`. Before, they were `any` in every app test.

Breaking: `TesterConfig` now takes `<TSchema, TDatabase, TRepositories, TContext, TCaller>` (it is `IntegrationTesterConfig` with the context and caller moved last). `TesterBuilder['create']` is generic over those three inferred types. Type the `db` parameter of `createRepositories` if your tests need a narrower database type than the default.

The rest of the package no longer uses `any` either. `IntegrationTester` closes database connections, reads `closeEventStore`, and finds tables in the schema (with Drizzle's `is(table, PgTable)`) by checking at runtime instead of casting. The debug helpers, `assertErrorThrown`, `assertNoError`, `comparePerformance` and `baseFactories` take `unknown` instead of `any`. `assertDeepPartialMatch` takes `unknown` and reports a missing property when the actual value is not an object. `createFactory` has real overloads instead of a cast.

Breaking: `withTransaction` returns `Promise<void>` (it always rolled back and returned `undefined`, so its old `Promise<T>` was a lie). `seed` takes `Record<string, readonly object[]>`, and a name in the schema that is not a table now throws "not found". `assertContainsId` and `assertNotContainsId` need a field name when the items have no `id`. `assertArraySorted` throws when it cannot order two values (it only orders numbers, bigints, strings and dates) instead of passing silently. `TypedFactoryRegistry` has an `unknown` index signature instead of `any`; use `TypedFactoryRegistryInstance` for typed access.
