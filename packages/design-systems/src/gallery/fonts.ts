/**
 * Gallery design system — font CSS variable references.
 *
 * Font faces are loaded via `@arki/design-systems/gallery/fonts.css`
 * (transitively imported by `gallery/tokens.css`).
 * Apply those variables to Tailwind by importing the theme-bridge.
 */

/** Body / UI text — Hanken Grotesk */
export const sans = { variable: '--font-sans', className: '' } as const;

/** Figures / technical — IBM Plex Mono */
export const mono = { variable: '--font-mono', className: '' } as const;

/** Display + curatorial voice — Newsreader */
export const serif = { variable: '--font-serif', className: '' } as const;
