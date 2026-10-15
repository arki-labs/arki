---
'@arki/dot': minor
---

Every hook and `provides` factory gets `$signal` in its kernel context: one `AbortSignal` per hook call that aborts when the hook exceeds `defineApp(name, { hookTimeoutMs })`, with the `DOT_LIFECYCLE_E015` error as its reason. A promise cannot be killed, so before this a hung hook (a connect that never settles) kept running after the kernel gave up on it; a hook that passes `$signal` to its I/O now stops. `$signal` joins the reserved `$` keys.
