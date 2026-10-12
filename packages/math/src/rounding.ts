/**
 * One rounding vocabulary for the whole package. The names follow Java's
 * `RoundingMode` and brick/math, which most developers already know.
 *
 * - `up`: away from zero. `down`: toward zero.
 * - `ceiling`: toward +∞. `floor`: toward −∞.
 * - `halfUp`: nearest, ties away from zero (what schools teach; `Intl`'s `halfExpand`).
 * - `halfDown`: nearest, ties toward zero.
 * - `halfEven`: nearest, ties to the even digit ("banker's rounding").
 * - `unnecessary`: throw `RoundingNecessaryError` if any digit would be lost.
 */
export const ROUNDING_MODES = [
  'up',
  'down',
  'ceiling',
  'floor',
  'halfUp',
  'halfDown',
  'halfEven',
  'unnecessary',
] as const;

export type RoundingMode = (typeof ROUNDING_MODES)[number];

export function isRoundingMode(value: unknown): value is RoundingMode {
  return typeof value === 'string' && (ROUNDING_MODES as readonly string[]).includes(value);
}
