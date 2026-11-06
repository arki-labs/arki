/**
 * `@arki/auth/testing/integration-tester` — `IntegrationTester` and `initTester`: a real Postgres and Redis, repositories and role callers for one backend's tests.
 *
 * It lives in `@arki/auth` because its test users carry an auth `UserId`. The generic parts
 * (containers, factories, assertions, timestamps, debug and performance helpers) come from
 * `@arki/testing`. Import this module only from tests: `@arki/testing`, `testcontainers` and
 * `@testcontainers/postgresql` are optional peers, and it needs Docker unless a global connection
 * string is set.
 *
 * @example
 * const t = initTester.context<AppContext>().caller<Caller>().create(config);
 * export const createTester = t.tester.withFactories(factories);
 */
export * from './integration-tester.js';
export * from './tester-builder.js';
