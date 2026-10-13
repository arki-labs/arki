import { z } from 'zod';

/**
 * Per-system display labels for the three @arki/theme modes.
 * v1 maps light/system/dark; v2 may introduce true named palettes.
 */
export const paletteLabelsSchema = z.object({
  light: z.string().min(1),
  system: z.string().min(1),
  dark: z.string().min(1),
});

export type PaletteLabels = z.infer<typeof paletteLabelsSchema>;
