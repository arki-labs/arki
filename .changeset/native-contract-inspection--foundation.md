---
"@arki/clock": minor
"@arki/contracts": patch
---

Remove the retired Clock abort exception code; cancellation remains the canonical SleepCancelled value. Preserve prototype-shaped operation keys in TanStack client utilities, and run Contracts native/provider inspections through identity-preserving source schemas. Forged array methods no longer bypass operation identity validation.

Docs describe the retired code and identity guarantees. No demo impact: existing demos use live cancellation outcomes and ordinary operation keys.
