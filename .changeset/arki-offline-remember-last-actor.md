---
'@arki/offline': patch
---

A write queued while the session is unknown (an offline reload, `actorId()` answers `null`) is now bound to the last actor signed in on this device, kept under `<storageKey>:last-actor`. Before, it was bound to `null`, and once the user signed back in it was dead-lettered as `ACTOR_MISMATCH` and could only be discarded. Replay rules are unchanged: it is sent only while that same user is signed in, and is dead-lettered for any other account.

The replay also reads `actorId()` right before every send attempt (each entry and each retry), not once per drain pass, so an account switch in the middle of a replay dead-letters the remaining writes as `ACTOR_MISMATCH` instead of sending them under the new session.
