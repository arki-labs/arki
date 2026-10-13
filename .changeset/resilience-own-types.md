---
'@arki/resilience': minor
---

The package now owns its public types and errors. `Policy` replaces cockatiel's `IPolicy`: `execute(fn, signal?)` gives `fn` a `{ signal, attempt }` context, and every policy exposes `onSuccess` and `onFailure`, with `onRetry`, `onGiveUp`, `onBreak`, `onHalfOpen`, `onReset`, `onTimeout` and `onReject` on the policies that have them. `CircuitOpenError`, `TimeoutError` and `BulkheadRejectedError` are this package's own classes with the engine error as `cause`, and a call cancelled by the caller's signal now rejects with `CancelledError` instead of being reported as a timeout. The `wrap` and `noop` exports are this package's own too. No cockatiel name appears in the published types anymore, so a cockatiel major release is no longer a breaking change here. The engine is upgraded to cockatiel 4.

Breaking: import `Policy` instead of `IPolicy`. Errors thrown by the policies are no longer `instanceof` cockatiel's classes.
