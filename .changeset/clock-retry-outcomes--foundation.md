---
'@arki/async': patch
---

Propagate exact Clock sleep failures through retry policies, composition, fallback helpers and Dot services. Retry stops on a failed wait. Owned scopes recognize canonical Clock cancellation only with their private cancellation cause. Callers must inspect retry outcomes; success remains unwrapped.

Transactions and HTTP clients map wait refusals to their existing cancellation/defect contracts without repeating the operation.
