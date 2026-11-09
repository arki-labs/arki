---
"@arki/icons": patch
---

The `phosphorPerIcon` Vite plugin reads each module in one pass. Many `import {` with no `}` after them, or a long run of spaces in a specifier, made it read the rest of the module again from each one. It rewrites the same statements as before.
