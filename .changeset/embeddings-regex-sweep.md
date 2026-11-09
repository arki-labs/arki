---
"@arki/embeddings": patch
---

`createCohereReranker` and `createCohereCompatibleReranker` read a 400 or 422 error body in one pass when they look for a context-length message. A long body of `max` words with no `.` made it read on from each one. It returns `InputTooLong` for the same bodies as before.
