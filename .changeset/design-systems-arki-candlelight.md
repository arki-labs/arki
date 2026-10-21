---
'@arki/design-systems': minor
---

Adds Candlelight, an opt-in warm palette for the `arki` system, in both modes. `<html class="candlelight">` is parchment (`#F3E7D3`), sepia ink (`#2B1D12`) and a deep amber primary (`#9A4217`). `<html class="dark candlelight">` is warm brown-black (`#16100B`), parchment text (`#E2D3B8`) and the soap bubble's amber (`#F0935D`). Light and dark still come from `.dark`, so Tailwind's `dark:` variant keeps working. Each block restates every colour token; all text pairs pass WCAG AA (lowest 4.99:1 in light, 5.28:1 in dark). New token `--arki-candle-glow`: a soft radial glow in Candlelight, `none` otherwise.

no demo impact: both demos (drop-studio, faultline) import the `atelier` system; this change only touches `arki/tokens.css`.
