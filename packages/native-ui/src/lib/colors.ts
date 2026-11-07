/**
 * Color utilities and theme constants for React Native UI
 */

/**
 * Checks if a color string is a valid hex color
 * @param color - Color string to validate
 * @returns True if valid hex color
 */
export function isValidHexColor(color: string): boolean {
  return /^#(?:[A-F0-9]{6}|[A-F0-9]{3}|[A-F0-9]{8})$/i.test(color);
}

type Rgba = { r: number; g: number; b: number; a: number };

/**
 * Reads `#rgb`, `#rrggbb` or `#rrggbbaa` (the forms `isValidHexColor` accepts) into channels.
 * `a` is 0-1. Throws `RangeError` for any other text: these helpers build colors from
 * developer-written values, so a bad value is a bug in the caller, not input to recover from.
 */
function readHex(hex: string): Rgba {
  if (!isValidHexColor(hex)) {
    throw new RangeError(`Expected a hex color like #abc, #aabbcc or #aabbccdd, got "${hex}"`);
  }
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

const toHexPair = (channel: number): string => channel.toString(16).padStart(2, '0');

/**
 * Converts hex color to RGBA
 * @param hex - `#rgb`, `#rrggbb` or `#rrggbbaa`
 * @param alpha - Alpha value (0-1); multiplied with the alpha pair of an 8-digit hex
 * @returns RGBA color string
 * @throws RangeError when `hex` is not a hex color (see `isValidHexColor`)
 */
export function hexToRgba(hex: string, alpha = 1): string {
  const { r, g, b, a } = readHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * alpha * 1000) / 1000})`;
}

/**
 * Lightens a hex color by a percentage. The alpha pair of an 8-digit hex is kept.
 * @param hex - `#rgb`, `#rrggbb` or `#rrggbbaa`
 * @param percent - Percentage to lighten (0-100)
 * @returns Lightened `#rrggbb` color (`#rrggbbaa` when the input had an alpha pair)
 * @throws RangeError when `hex` is not a hex color (see `isValidHexColor`)
 */
export function lightenColor(hex: string, percent: number): string {
  const { r, g, b } = readHex(hex);
  const amount = Math.round(2.55 * percent);
  const shift = (channel: number): string => toHexPair(Math.min(255, Math.max(0, channel + amount)));
  const alphaPair = hex.length === 9 ? hex.slice(7) : '';
  return `#${shift(r)}${shift(g)}${shift(b)}${alphaPair}`;
}

/**
 * Darkens a hex color by a percentage. The alpha pair of an 8-digit hex is kept.
 * @param hex - `#rgb`, `#rrggbb` or `#rrggbbaa`
 * @param percent - Percentage to darken (0-100)
 * @returns Darkened `#rrggbb` color (`#rrggbbaa` when the input had an alpha pair)
 * @throws RangeError when `hex` is not a hex color (see `isValidHexColor`)
 */
export function darkenColor(hex: string, percent: number): string {
  return lightenColor(hex, -percent);
}
