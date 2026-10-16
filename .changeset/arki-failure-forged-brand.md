---
'@arki/failure': minor
'@arki/log': minor
---

Security: outside data can no longer pass as a failure. `isFailure` (and `@arki/log`'s failure check) now require the `~failure` brand on the value's prototype and refuse it as an own property. Before, JSON such as `{"~failure": true, "code": "x", "status": 500}` from an API response, queue message or tool result counted as a failure, so boundaries skipped output schemas and answered with an attacker-chosen status or code. Real failures, revived ones and failures from a second copy of the package are still recognised.
