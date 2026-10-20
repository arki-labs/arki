---
'@arki/db': patch
---

Trace local database initialization, file ownership acquisition and owned close
through the application-configured OpenTelemetry provider. Spans inherit the
active caller context and record only canonical failure codes. Concurrent close
calls share one attempt; broken or reentrant reporting cannot duplicate work,
alter exact failure results or release unconfirmed ownership.
