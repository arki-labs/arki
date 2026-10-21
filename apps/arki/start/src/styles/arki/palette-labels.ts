/** The Arki names for the light, system and dark modes (the brand palettes) and the two candle palettes. */
import type { PaletteLabels } from '@fleet/design-systems/palette-labels';

import type { ArkiTheme } from './themes';

/** One label per Arki theme. SiteKit reads the three shared modes; the candle names live only here. */
export const arkiPaletteLabels = {
  light: 'mineral',
  system: 'auto',
  dark: 'signal',
  'candle-light': 'parchment',
  'candle-dark': 'drafting table',
} satisfies PaletteLabels & Record<ArkiTheme, string>;
