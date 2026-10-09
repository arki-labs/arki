import { z } from 'zod';

import { arenaPaletteLabels } from './arena/palette-labels';
import { arenaTypography } from './arena/typography';
import { atelierPaletteLabels } from './atelier/palette-labels';
import { atelierTypography } from './atelier/typography';
import { paletteLabelsSchema } from './palette-labels';
import { tribunalPaletteLabels } from './tribunal/palette-labels';
import { tribunalTypography } from './tribunal/typography';
import { typographyRosterSchema } from './typography';
import { workbenchPaletteLabels } from './workbench/palette-labels';
import { workbenchTypography } from './workbench/typography';

/**
 * Canonical identifier for a supported design system.
 */
export const designSystemIdSchema = z.enum([
  'atelier',
  'workbench',
  'arena',
  'tribunal',
]);

/**
 * Union type of supported design system identifiers.
 */
export type DesignSystemId = z.infer<typeof designSystemIdSchema>;

/**
 * Metadata schema for a single design system. Exported so a private
 * registry (product-named systems) can extend it with its own ids.
 */
export const designSystemMetadataSchema = z.object({
  id: designSystemIdSchema,
  name: z.string().min(1),
  packagePath: z.string().min(1),
  description: z.string().min(1),
  typography: typographyRosterSchema,
  paletteLabels: paletteLabelsSchema,
});

/**
 * Metadata describing a named design system.
 */
export type DesignSystemMetadata = z.infer<typeof designSystemMetadataSchema>;

const createDesignSystemsRecord = (): Record<DesignSystemId, DesignSystemMetadata> => ({
  atelier: designSystemMetadataSchema.parse({
    id: 'atelier',
    name: 'Atelier',
    packagePath: '@arki/design-systems/atelier',
    description:
      'Warm, scholarly aesthetic with serif-led hierarchy, hand-crafted motifs, and generous whitespace.',
    typography: atelierTypography,
    paletteLabels: atelierPaletteLabels,
  }),
  workbench: designSystemMetadataSchema.parse({
    id: 'workbench',
    name: 'Workbench',
    packagePath: '@arki/design-systems/workbench',
    description:
      'Editorial notebook aesthetic with warm paper tones, monochrome hierarchy, and pastel accent surfaces.',
    typography: workbenchTypography,
    paletteLabels: workbenchPaletteLabels,
  }),
  arena: designSystemMetadataSchema.parse({
    id: 'arena',
    name: 'Arena',
    packagePath: '@arki/design-systems/arena',
    description:
      'Game arena aesthetic with cool-neutral chrome, amplified status colors (win/lose/hint/score), game-piece depth, and Tier 3 celebration motion.',
    typography: arenaTypography,
    paletteLabels: arenaPaletteLabels,
  }),
  tribunal: designSystemMetadataSchema.parse({
    id: 'tribunal',
    name: 'Tribunal',
    packagePath: '@arki/design-systems/tribunal',
    description:
      'Editorial-evidence aesthetic with cream-paper foundations, serif-led hierarchy, a "Brand" stage palette for run-stage colour-coding, and sober GO/CAUTION/REWORK verdict bands. The register of a case file, not a SaaS dashboard.',
    typography: tribunalTypography,
    paletteLabels: tribunalPaletteLabels,
  }),
});

const designSystemsRecord = createDesignSystemsRecord();

/**
 * Ordered list of available design systems.
 */
export const DESIGN_SYSTEMS: readonly DesignSystemMetadata[] = Object.freeze(
  Object.values(designSystemsRecord).map((system) => Object.freeze({ ...system })),
);

/**
 * Ordered list of available design system identifiers.
 */
export const DESIGN_SYSTEM_IDS: readonly DesignSystemId[] = Object.freeze(
  DESIGN_SYSTEMS.map((system) => system.id),
);

/**
 * Returns true when the provided value is a valid {@link DesignSystemId}.
 */
export function isDesignSystemId(value: unknown): value is DesignSystemId {
  return designSystemIdSchema.safeParse(value).success;
}

/**
 * Parses a value into a {@link DesignSystemId}.
 *
 * @throws ZodError when value is not a supported design system id.
 */
export function parseDesignSystemId(value: unknown): DesignSystemId {
  return designSystemIdSchema.parse(value);
}

/**
 * Resolves a design system id from arbitrary input with a safe fallback.
 */
export function resolveDesignSystemId(
  value: unknown,
  fallback: DesignSystemId = 'atelier',
): DesignSystemId {
  const parsed = designSystemIdSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

/**
 * Returns metadata for the requested design system id.
 */
export function getDesignSystemById(id: DesignSystemId): DesignSystemMetadata {
  return designSystemsRecord[id];
}

/**
 * Safely resolves metadata from arbitrary input.
 */
export function getDesignSystemByIdSafe(value: unknown): DesignSystemMetadata | null {
  const parsed = designSystemIdSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }

  return designSystemsRecord[parsed.data];
}
