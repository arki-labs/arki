---
'@arki/ts': patch
---

`PathValue` is cheaper to type-check: it now follows the path it is given instead of listing every path of the object, and only falls back to the full `RecordToPath` list when that walk does not find the path (for example a key that contains a dot). It accepts the same paths and gives the same types as before. In the benchmark it now needs fewer type instantiations than ts-essentials `PathValue` (1,034 against 1,074; it was 2,731). `RecordToPath` drops a condition that was always true, which also makes it slightly cheaper (1,814 instantiations, was 1,872).
