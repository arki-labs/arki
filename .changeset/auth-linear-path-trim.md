---
"@arki/auth": patch
---

The handler trims trailing slashes from the request path in one pass. A path with a long run of slashes that did not end the path made the old regex trim quadratic.
