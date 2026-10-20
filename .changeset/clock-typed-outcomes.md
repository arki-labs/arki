---
"@arki/clock": minor
---

Return canonical SleepCancelled outcomes from sleep instead of rejecting on abort, preserving private causes and timer cleanup. Invalid timer and mock-step setup still throws ClockError. Supervise asynchronous provider cleanup before settlement and observe listener registration rejections without leaking unhandled promises.
