import type { TypographyRoster } from '../typography';

/**
 * Atelier is editorial/warm. Roster surfaces display-serif and serif options;
 * no sans-serif heading variants on offer (those belong to Workbench).
 *
 * Resolution per D16 (spec correction): Cormorant Garamond and Playfair Display
 * ship variable builds on @fontsource-variable; Instrument Serif and Gentium Plus
 * do NOT have variable builds upstream — they ship as @fontsource only. The CSS
 * font-family string omits the "Variable" suffix for those two so the family
 * resolves against the actual loaded face.
 */
export const atelierTypography: TypographyRoster = {
  default: 'instrument',
  variants: [
    {
      id: 'instrument',
      label: 'Instrument',
      fontFamily: '"Instrument Serif", "Fraunces Variable", serif',
    },
    {
      id: 'cormorant',
      label: 'Cormorant',
      fontFamily: '"Cormorant Garamond Variable", "Fraunces Variable", serif',
    },
    {
      id: 'playfair',
      label: 'Playfair',
      fontFamily: '"Playfair Display Variable", "Fraunces Variable", serif',
    },
    {
      id: 'magazine',
      label: 'Magazine',
      fontFamily: '"Gentium Plus", "Fraunces Variable", serif',
    },
  ],
};
