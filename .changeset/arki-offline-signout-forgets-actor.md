---
'@arki/offline': minor
---

`actorId()` now tells "signed out" (`null`) from "not known yet" (`undefined`). Only `undefined` falls back to the device's last actor; `null` forgets it. Before, a write queued after a sign-out on a shared device was bound to the user who had left and replayed as them when they signed in again. Return `undefined` while the session loads.
