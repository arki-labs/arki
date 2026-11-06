AGENTS.md = laws, docs/agent-guide.md = tasks, llms.txt = map.

# @arki/payments-native

A thin wrapper over `react-native-purchases` (RevenueCat) for in-app purchases. When a doc and the code disagree, `src/index.ts` wins.

## Laws

1. This package is the purchase rail only. It never reads entitlements. The app reads "is this user Pro" from its own backend.
2. `react-native-purchases` is a peer dependency. The app owns its install and native setup.
3. A failure is returned, never thrown. `configureRevenueCat` is the one call that can throw, because it calls the SDK directly.
4. A user who backs out of the purchase sheet is a normal result, `{ status: 'cancelled' }`. It is never a failure.
5. The SDK error stays private as the failure's `cause`.
6. `appUserId` is the id the backend signs users in with, so the webhook can attribute the purchase.
7. Spans use the OpenTelemetry API only. The API key, user id, package ids, prices and `CustomerInfo` are never attributes.
8. Every error code has JSDoc with a summary, `@fix` and `@verify`.
9. Types are written once and inferred everywhere.
10. A public export is never deleted because nothing uses it. Breaking changes are a minor changeset while the version is 0.x.

## Changing this package

1. Read `docs/agent-guide.md` for your task.
2. Change `src/`. Put the test next to it.
3. Keep README blocks compiling. A block that needs the RevenueCat native module is marked `skip` with its reason.
4. Add a changeset.
5. Regenerate the import paths in `llms.txt`: `bun ../../tooling/library/src/llms.ts --write`.

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
