---
'@arki/ui': minor
---

Adds the theme from `@arki/theme` as `@arki/ui/theme` (`ThemeProvider`, `useTheme`) and `@arki/ui/theme/script` (`themeScript`, `themeDetectionFn`, `THEME_STORAGE_KEY`). The code is unchanged, plus the unreleased `themeClasses` option: a theme can set several classes on the root element, and changing the theme removes them all. `@arki/ui` no longer depends on `@arki/theme`; that package is retired. To upgrade, replace `@arki/theme` with `@arki/ui/theme` and `@arki/theme/script` with `@arki/ui/theme/script`.

demo impact: drop-studio's and faultline's `arki.deps.json` list `@arki/theme`; rename their imports and drop that entry on their next upgrade.
