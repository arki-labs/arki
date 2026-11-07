---
"@arki/native-ui": minor
---

Breaking: `hexToRgba`, `lightenColor` and `darkenColor` read `#rgb`, `#rrggbb` and `#rrggbbaa` correctly (the forms `isValidHexColor` accepts). They keep the alpha pair of an 8-digit hex, and `hexToRgba` multiplies it with its `alpha` argument. Text that is not a `#` hex color now throws `RangeError`, where it used to return a wrong color. Check with `isValidHexColor` first if the text is not under your control.
