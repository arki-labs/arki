import type { PaletteLabels } from '../palette-labels';

/**
 * Gallery light/dark idiom. The bonus `sepia` theme lives in tokens.css as
 * `[data-theme='sepia']` and is opted into beyond this three-way toggle.
 */
export const galleryPaletteLabels: PaletteLabels = {
  light: 'day',
  system: 'auto',
  dark: 'night',
};
