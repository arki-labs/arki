---
'@arki/ui': patch
---

`ThemeProvider` now shows a stored theme after hydration. Its first render read `localStorage` in the browser but not on the server, and React keeps mismatched attributes during hydration, so a theme switcher stayed on the server's default (for example "Auto" while Lamplight was active). The provider now renders the default on both sides, reads the stored theme and the OS preference in a layout effect before the first paint, and leaves the pre-paint script's classes alone until then. No docs impact: behaviour now matches what the theme docs already describe. No demo impact: no demo covers theme hydration.
