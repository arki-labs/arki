---
'@arki/math': patch
---

`formatFileSize` takes `system: 'jedec'`: powers of 1024 with `KB`, `MB`, `GB` labels (`1536` gives `'1.5 KB'`), the convention Windows and many file managers use. `'si'` (base 1000, `kB`) stays the default; `'iec'` gives `KiB`, `MiB`.
