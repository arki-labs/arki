import type { TypographyRoster } from '../typography';

/**
 * Tribunal is editorial-evidence. The roster surfaces display-face
 * choices for headlines and the verdict number; body prose always
 * uses Newsreader and chrome always uses Geist regardless of choice.
 *
 * Variants are limited to faces actually loaded by `fonts.css`
 * (Spectral, Newsreader, Geist) so a roster pick never silently
 * degrades to a system fallback. The source prototype sketched six
 * pairings (editorial / magazine / romantic / geometric / poster /
 * modern); those extra display faces are not bundled and were not
 * carried over — add the @fontsource import alongside a variant if a
 * future pairing is committed.
 */
export const tribunalTypography: TypographyRoster = {
  default: 'editorial',
  variants: [
    {
      id: 'editorial',
      label: 'Editorial',
      fontFamily: '"Spectral", "Newsreader Variable", Georgia, serif',
    },
    {
      id: 'broadsheet',
      label: 'Broadsheet',
      fontFamily: '"Newsreader Variable", "Spectral", Georgia, serif',
    },
    {
      id: 'dispatch',
      label: 'Dispatch',
      fontFamily: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
    },
  ],
};
