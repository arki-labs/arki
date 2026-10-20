---
"@arki/http": minor
"@arki/journal": minor
"@arki/kv": minor
---

Keep unresolved HTTP idempotency reservations until reconciliation and return precise canonical cache failures. Replay retention starts at confirmed persistence; all bounded responses, including error statuses, are stored. Oversized requests are refused before execution, and unreplayable responses retain their reservation.

ResponseCache.begin no longer accepts a TTL; finish requires it. Postgres/Redis adapters confirm ownership and preserve unresolved claims; Journal pruning respects their lifecycle. Coordinate writer upgrades and reconcile legacy expiring reservations. See @arki/http/docs/upgrade-idempotency.md.
