---
'@arki/dot': minor
---

`dot dev` serves a console on `--console-port` (default 4321) with one page per projection that registers `console: { title }`. The projection module exports `consolePage(document)`; the console runs `dot explain --as <format> --page` for each request and wraps the HTML in a shell with light and dark tokens. `dot explain --page` is new. `ProjectionManifest` gains `console`. A taken console port prints a warning and `dot dev` runs without the console. No demo impact: the console has no demo.
