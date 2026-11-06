---
'@arki/offline': minor
---

Offline spans mark only faults (status 500 or higher) as errors. An expected refusal, such as a mutation that cannot be serialized, keeps `failure.code` and leaves the span status unset.
