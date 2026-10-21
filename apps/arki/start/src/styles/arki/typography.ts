/** The Arki heading-font roster a user can pick from: Archivo is the brand face; the others are alternates. */
import type { TypographyRoster } from '@fleet/design-systems/typography';

export const arkiTypography: TypographyRoster = {
  default: 'archivo',
  variants: [
    {
      id: 'archivo',
      label: 'Archivo',
      fontFamily: '"Archivo Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'plex',
      label: 'Plex Sans',
      fontFamily: '"IBM Plex Sans Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'mono-display',
      label: 'Mono Display',
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
    },
  ],
};
