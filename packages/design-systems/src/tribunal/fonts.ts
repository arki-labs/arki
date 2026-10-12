/**
 * Tribunal design system — font CSS variable references.
 *
 * Font faces are loaded via `@arki/design-systems/tribunal/fonts.css`.
 * Apply those variables to Tailwind by importing the theme-bridge.
 */

/** UI chrome — Geist Variable */
export const sans = { variable: '--font-sans', className: '' } as const;

/** Scores and tabular data — JetBrains Mono Variable */
export const mono = { variable: '--font-mono', className: '' } as const;

/** Conversational rail, prose, evidence copy — Newsreader Variable */
export const serif = { variable: '--font-serif', className: '' } as const;

/** Headlines and the verdict number — Spectral */
export const display = { variable: '--font-display', className: '' } as const;
