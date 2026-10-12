import type { TypographyRoster } from '../typography';

/**
 * Gallery is editorial-first: an optical display serif for titles and the
 * curatorial voice, a quiet engraved-label sans for UI, one mono for figures.
 */
export const galleryTypography: TypographyRoster = {
  default: 'editorial',
  variants: [
    {
      id: 'editorial',
      label: 'Editorial',
      fontFamily: '"Newsreader Variable", ui-serif, Georgia, serif',
    },
    {
      id: 'label',
      label: 'Label',
      fontFamily: '"Hanken Grotesk Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'mono-figure',
      label: 'Mono Figure',
      fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    },
  ],
};
