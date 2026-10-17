---
'@arki/failure': minor
---

New `Stoppable<Value, Failures>` type for a partial success: `Value & { readonly stoppedBy?: Failures }`. Callers read `result.stoppedBy` directly, with no `'stoppedBy' in result` check. `orThrowRpc` (`@arki/failure/orpc`) takes an optional third argument: `orThrowRpc(value, errors, success)` throws the failure as before, or returns `success`. It is for a usecase that returns nothing or a failure, such as `return orThrowRpc(await disconnect(id), errors, { success: true })`. The two-argument form is unchanged. The README gains an "Adopting in an app" section, and "Choosing a status" now says to name an upstream HTTP status `upstreamStatus`.
