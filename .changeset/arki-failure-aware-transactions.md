---
'@arki/db': minor
---

Return a canonical failure from a transaction callback to roll back its writes and preserve the original failure. Successful callbacks commit. The transaction helpers now expose inferred failure outcomes for database faults, cancellation and uncertain commits; inspect those outcomes before using success values.

Serializable retries remain bounded to PostgreSQL serialization failures and deadlocks. An uncertain commit is never automatically replayed. Plain transaction wrappers retain their existing isolation and single-attempt behavior.

Transactional oRPC procedures declare the canonical transaction error map. Their middleware classifies `result.output` and preserves the surrounding result metadata. See the database transaction upgrade guide for caller and contract migration steps.
