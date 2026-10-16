---
'@arki/admin': patch
---

Security: a repeated execute answers from its receipt only when it is the same signed request. Receipts now store `requestHash`, the SHA-256 over the canonical JSON of the envelope's audience, method, path, body hash and permit. Before, only the action id was compared, so the same execution id with other input or another pinned revision was answered "applied" with the first result, though it never ran. A mismatch is refused with `ARKI_ADMIN_E010`. Receipts written before this field are still matched by action id, so an execution that spans the upgrade is not sent back for a second approval.
