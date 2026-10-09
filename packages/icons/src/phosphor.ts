/**
 * Phosphor Icons — primary entry point.
 *
 * Re-exports every icon component from `@phosphor-icons/react` plus the
 * `IconContext` provider used to set defaults (size, color, weight, mirrored)
 * for a subtree.
 *
 * For Server Components or any tree where you don't need icons to subscribe
 * to `IconContext`, prefer `@arki/icons/phosphor/ssr` — it ships a smaller,
 * statically-rendered variant with no runtime context lookup.
 *
 * @see https://phosphoricons.com
 * @see {@link IconContext}
 */
export * from '@phosphor-icons/react';
export { IconContext } from '@phosphor-icons/react';
export type { Icon, IconProps, IconWeight } from '@phosphor-icons/react';
