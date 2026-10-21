/** The Arki themes and the classes each puts on `<html>`, for `@arki/ui/theme`'s `themes` and `themeClasses` options. */

/** Theme values in display order: Light, Candle light, Candle dark, Dark, then system. */
export const arkiThemes = ['light', 'candle-light', 'candle-dark', 'dark', 'system'] as const;

export type ArkiTheme = (typeof arkiThemes)[number];

/** The classes `arki/tokens.css` reacts to. `system` has none: it resolves to light or dark first. */
export const arkiThemeClasses = {
  light: [],
  'candle-light': ['candlelight'],
  'candle-dark': ['dark', 'candlelight'],
  dark: ['dark'],
} as const satisfies Record<Exclude<ArkiTheme, 'system'>, readonly string[]>;
