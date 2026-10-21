---
'@arki/dot': minor
---

`dot new` apps no longer depend on `@arki/design-systems`. The workbench theme (fonts, tokens and the Tailwind bridge) is now written into the app as `src/workbench.css`, and the app depends on its three `@fontsource` packages instead. The `versions.designSystems` option of the scaffold planner is gone.

no demo impact: no demo scaffolds an app or reads the scaffold versions.
