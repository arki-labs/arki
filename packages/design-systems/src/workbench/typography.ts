import type { TypographyRoster } from '../typography';

/**
 * Workbench is utility-first. Roster surfaces sans-serif and one mono;
 * no display serifs (those belong to Atelier).
 */
export const workbenchTypography: TypographyRoster = {
  default: 'geometric',
  variants: [
    {
      id: 'geometric',
      label: 'Geometric',
      fontFamily: '"Plus Jakarta Sans Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'modern',
      label: 'Modern',
      fontFamily: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
    },
    {
      id: 'mono-display',
      label: 'Mono Display',
      fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
    },
  ],
};
