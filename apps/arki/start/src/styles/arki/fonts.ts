/**
 * Arki design system — font CSS variable references.
 *
 * Font faces are loaded via `./fonts.css`.
 * Apply those variables to Tailwind by importing the theme-bridge.
 */

/** Body text and UI — IBM Plex Sans Variable */
export const sans = { variable: '--font-sans', className: '' } as const;

/** Code and metrics — JetBrains Mono Variable */
export const mono = { variable: '--font-mono', className: '' } as const;

/** Arki has no serif: this variable resolves to the heading face, Archivo Variable. */
export const serif = { variable: '--font-serif', className: '' } as const;
