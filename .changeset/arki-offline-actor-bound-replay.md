---
'@arki/offline': minor
---

Security: a queued offline write no longer replays under whoever is signed in when the browser reconnects. `createOfflineMutationQueue` and the `'queue'` tier of `createOfflineRuntime` now require `actorId: () => string | null`. Each entry stores the actor signed in at enqueue. At replay the entry is sent only while that same actor is signed in. Nobody signed in: it stays queued and the queue emits `'auth-required'`. Another actor signed in: it is dead-lettered unsent with `lastError.code === 'ACTOR_MISMATCH'`. `deadLetter.retry` keeps the original actor. New exported type `QueueErrorCode`.
