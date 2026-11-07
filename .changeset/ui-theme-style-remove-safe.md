---
"@arki/ui": patch
---

`ThemeProvider` with `disableTransitionOnChange` no longer throws inside a timer when something else removed its temporary style node first.
