import type { TypographyRoster } from '../typography';

/**
 * Arena is game-first. Roster surfaces bold/expressive display faces.
 * Narrower than Atelier/Workbench because most arena UI is iconography +
 * numeric, not prose — variant choice has less surface to express.
 */
export const arenaTypography: TypographyRoster = {
  default: 'display',
  variants: [
    {
      id: 'display',
      label: 'Display',
      fontFamily: '"Sora Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'poster',
      label: 'Poster',
      fontFamily: '"Druk Wide", "Sora Variable", sans-serif',
    },
  ],
};
