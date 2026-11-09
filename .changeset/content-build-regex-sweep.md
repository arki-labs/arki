---
"@arki/content-build": patch
---

Reading time leaves inline `<svg>` blocks out in one pass. A post with many `<svg` tags and no `</svg>` after them read on to the end from each tag. It removes the same blocks as before.
