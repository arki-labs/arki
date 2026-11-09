---
"@arki/admin": patch
---

The Coolify client reads the version answer in one pass. A long run of digits with no `.x.y` after it made it read the run again from every digit. It finds the same version as before.
