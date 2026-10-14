---
'@arki/async': minor
---

New foundation package. `sleep(ms, { signal })` waits and can be aborted; `debounce` and `throttle` follow the lodash contract (checked against lodash on random call schedules) and return a function with `cancel`, `flush` and `pending`. Zero dependencies, runs on Node, Bun, Deno, browsers and Hermes, and every failure is an `AsyncError` with a code (`ARKI_ASYNC_E001` invalid wait, `ARKI_ASYNC_E002` aborted).
