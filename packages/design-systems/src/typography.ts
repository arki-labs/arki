import { z } from 'zod';

/**
 * A single user-selectable heading-font choice within a design system's roster.
 */
export const typographyVariantSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'id must be kebab-case'),
  label: z.string().min(1),
  fontFamily: z.string().min(1),
  sample: z.string().optional(),
});

export type TypographyVariant = z.infer<typeof typographyVariantSchema>;

/**
 * Ordered list of typography variants a design system exposes to users,
 * with a default selection used when no user choice exists.
 */
export const typographyRosterSchema = z
  .object({
    default: z.string(),
    variants: z.array(typographyVariantSchema).min(1),
  })
  .superRefine((roster, ctx) => {
    const ids = roster.variants.map((v) => v.id);
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'variant ids must be unique within a roster',
      });
    }
    if (!unique.has(roster.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `default '${roster.default}' must reference a variant id`,
      });
    }
  });

export type TypographyRoster = z.infer<typeof typographyRosterSchema>;

export function parseTypographyRoster(value: unknown): TypographyRoster {
  return typographyRosterSchema.parse(value);
}
