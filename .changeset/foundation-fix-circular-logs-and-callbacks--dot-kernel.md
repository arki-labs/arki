---
'@arki/env': minor
---

Fix the foundation findings of the T08 review.

- `@arki/log`: `maskSecrets` and `otelSink` handle an object that contains itself (the cycle becomes `[Circular]`) instead of dropping the record. A `.to('name')` logger whose channel is not defined no longer throws into the caller at log time; the fault is reported once and the channel is skipped. `file()` throws a coded `LogError` (`ARKI_LOG_E006`) when it cannot open its path.
- `@arki/async`: `debounce` and `throttle` take an `onError` option. An error thrown by the callback, or a promise it returns that rejects, goes there. Without it the error is rethrown from a microtask. The schedule stays consistent and a leading call never throws into the caller.
- `@arki/env`: `rotateEnvFiles` returns an `InvalidInput` failure for an empty list or files of two environments (it threw a plain `Error`). The default `onValidationError` of `defineEnv` throws an `UnexpectedFailure` that carries the new `env.invalid_environment` failure (`InvalidEnvironment`).
