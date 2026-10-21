---
'@arki/design-systems': minor
---

Adds Candlelight, an opt-in third mode for the `arki` system: warm brown-black (`#16100B`), parchment text (`#E2D3B8`) and the soap bubble's amber (`#F0935D`) as primary. It sits on top of dark, so an app sets `<html class="dark candlelight">` and Tailwind's `dark:` variant keeps working. It restates every dark token; all text pairs pass WCAG AA (lowest 5.28:1). New token `--arki-candle-glow`: a soft radial glow in Candlelight, `none` in light and dark.

no demo impact: both demos (drop-studio, faultline) import the `atelier` system; this change only touches `arki/tokens.css`.
