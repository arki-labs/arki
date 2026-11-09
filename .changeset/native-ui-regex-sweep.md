---
"@arki/native-ui": patch
---

`lightenColor` and `darkenColor` throw a `RangeError` when `percent` is not finite. Before, `NaN` gave the string `#NaNNaNNaN`, which reached a style prop with no error.
