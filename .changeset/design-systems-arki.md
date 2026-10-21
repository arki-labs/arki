---
'@arki/design-systems': minor
---

Adds the `arki` system, the arki brand. It keeps workbench's token names, density, radius and fonts, and sets every colour from the brand palettes: mineral in light (cream `#F2F0E9`, ink `#182338`, cobalt primary `#234DEB`) and signal in dark (blue-grey `#11191F`, pale `#E7EBEB`, orange primary `#FF683B`). It also adds the soap-bubble signature tokens `--arki-bubble-1` to `--arki-bubble-4` and `--arki-bubble-gradient`, for accents, focus and hero moments. New imports: `@arki/design-systems/arki/tokens.css`, `/arki/theme-bridge.css`, `/arki/fonts.css`, `/arki/fonts` and `/arki`. `DESIGN_SYSTEM_IDS` gains `'arki'`, so code that switches over every id must handle it.

no demo impact: drop-studio, the only registered demo, imports the `atelier` system; adding a system does not change atelier's tokens or the registry helpers it uses.
