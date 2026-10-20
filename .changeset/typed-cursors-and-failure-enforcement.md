---
'@arki/contracts': minor
'@arki/db': minor
'@arki/failure': minor
'@arki/dot': patch
'@arki/eslint-config': patch
'@arki/lock': minor
---

Cursor encoding and decoding return canonical failures. Database pagination
preserves those outcomes before building SQL or returning a page. Check codec
results and declare the original cursor failures at RPC boundaries.

Failure lint rules now catch discarded callback returns, nested aggregate and
iterator results, and blind acceptance through aliases or generic failure guards.
Handle each outcome or forward it to its owner.
Browser contract linting admits canonical failure definitions while keeping
exception bridges in implementations.
The exported lock conformance suite now checks each queued task's acquisition
outcome before accepting its completion counts.

Dot acquires telemetry instruments inside guarded execution, so importing before
SDK setup works and broken reporters cannot replace application outcomes.
