/**
 * Arena design system — font CSS variable references.
 *
 * Font faces are loaded via `@arki/design-systems/arena/fonts.css`.
 * Apply those variables to Tailwind by importing the theme-bridge.
 *
 * Arena is sans-led — the system intentionally has no characterful
 * display serif. The chrome stays calm so the game can pop.
 */

/** Body text and UI — Inter Variable */
export const sans = { variable: '--font-sans', className: '' } as const;

/** Scores, timers, code — JetBrains Mono Variable */
export const mono = { variable: '--font-mono', className: '' } as const;

/** Serif — system fallback only; reserved for occasional game titles */
export const serif = { variable: '--font-serif', className: '' } as const;
