/**
 * Phosphor Icons — SSR / static variant.
 *
 * Re-exports the static icon components from `@phosphor-icons/react/dist/ssr`.
 * These render identical SVG to the dynamic variant but skip the `IconContext`
 * subscription and `useId` hook, so they're cheaper and have no client/server
 * markup mismatch risk.
 *
 * Use these when:
 *   - rendering inside React Server Components
 *   - the icon doesn't need to inherit per-tree defaults
 *   - bundle size or hydration cost matters (e.g. lists, tables)
 *
 * For interactive/themed icons that should pick up
 * `<IconContext.Provider value={{ weight, size, color }}>` defaults, import
 * from `@arki/icons/phosphor` instead.
 */
export * from '@phosphor-icons/react/dist/ssr';
