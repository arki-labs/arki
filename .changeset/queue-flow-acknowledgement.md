---
"@arki/queue": patch
---

Return QueueAcceptanceUnknown for incomplete or malformed flow acknowledgements without resubmitting possibly accepted jobs. Preserve every confirmed step key, including prototype-named keys.
