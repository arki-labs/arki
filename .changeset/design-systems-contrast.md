---
'@arki/design-systems': patch
---

Atelier, workbench and arena now pass WCAG 2.1 AA contrast in light and dark, checked by a new contrast test. Only lightness changed, never hue or saturation: muted text, `input` borders and `destructive` red are darker in light mode; dark-mode `destructive` is lighter with dark `destructive-foreground` text; atelier's `primary` (and `ring`, `chart-1`, `sidebar-primary`, `sidebar-ring`) is a deeper amber. Arena's `lose`, `score-negative` and `chart-5` follow `destructive`.
