import { registerDesignSystem } from '@fleet/sitekit/register-design-system';

import { arkiPaletteLabels } from './palette-labels';
import { arkiTypography } from './typography';

declare module '@fleet/sitekit/design-system' {
  interface DesignSystemRegistry {
    arki: true;
  }
}

/**
 * Registers the arki brand with SiteKit. Call it from the app's providers module, before `AppProvider` renders
 * (server and client).
 */
export function registerArkiDesignSystem(): void {
  registerDesignSystem('arki', {
    name: 'Arki',
    packagePath: '~/styles/arki',
    description:
      'The arki brand: workbench density and type with the source-dot palettes, mineral (cream, ink, cobalt) in light and signal (blue-grey, orange) in dark, plus soap-bubble signature tokens for accents.',
    typography: arkiTypography,
    paletteLabels: arkiPaletteLabels,
  });
}
