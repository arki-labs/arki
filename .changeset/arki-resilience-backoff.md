---
'@arki/resilience': minor
---

New `backoff` builder: one retry schedule shared by every package that retries. `backoff.exponential({ base, max, jitter, random })` waits `base`, then doubles up to `max`; `backoff.constant(ms)` waits the same time each retry. `.upTo(n)` allows at most `n` retries, and `.while(predicate)` retries only the errors the predicate accepts. A backoff answers one question, `delay(attempt, error)`: the wait in milliseconds, or `undefined` to stop. `random` makes jitter deterministic in tests. A bad option throws the new `InvalidBackoffError` (`ARKI_RESILIENCE_E006`).

Retry delays now wait on a `Clock` from `@arki/clock`. Pass `clock: new MockClock()` and a retry with delays of seconds finishes instantly in tests. Retry is now its own loop instead of cockatiel's, because cockatiel's retry cannot take a clock.

Breaking:

- `createRetryPolicy` and `withRetry` take `{ backoff, clock }` instead of `{ maxAttempts, initialDelay, maxDelay, exponent }`. `maxAttempts: 3, initialDelay: 200, maxDelay: 5000` becomes `backoff: backoff.exponential({ base: 200, max: 5000 }).upTo(3)`.
- `createResiliencePolicy({ retry })` takes a `Backoff`, and a new `clock` option.
- The default retry and the presets now use plain doubling with 25% jitter instead of cockatiel's decorrelated jitter.
- `onFailure`'s `handled` is now true only when the policy will retry that failure.
