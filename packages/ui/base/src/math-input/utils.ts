import { MATH_CONSTANTS } from './constants';

/**
 * Maps a stored number to its human-readable display string.
 * - Exact IEEE-754 constant matches return their Unicode symbol (e.g. Math.PI → "π").
 * - Infinity → "+∞", -Infinity → "−∞".
 * - null → "".
 * - Any other number → String(n).
 */
export function numberToDisplay(value: number | null): string {
  if (value === null) return '';
  if (value === Infinity) return '+∞';
  if (value === -Infinity) return '−∞';
  const constant = MATH_CONSTANTS.find((c) => c.value === value);
  if (constant) return constant.symbol;
  return String(value);
}

/**
 * Parses a display string back to a number.
 * Handles:
 * - Unicode infinity glyphs and the string literals "Infinity" / "-Infinity"
 * - Constant symbols (π, e, φ, τ, √2, √3, ln2, γ)
 * - Fraction shorthand "a/b" (e.g. "3/4" → 0.75)
 * - Plain numeric strings
 * Returns null for empty or unparseable input.
 */
export function displayToNumber(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;

  // Positive infinity variants
  if (s === '+∞' || s === '∞' || s === 'Infinity' || s === '+Infinity') return Infinity;

  // Negative infinity variants
  if (s === '−∞' || s === '-∞' || s === '-Infinity') return -Infinity;

  // Named constant symbols and latex aliases
  for (const c of MATH_CONSTANTS) {
    if (s === c.symbol || s === c.latex) return c.value;
  }

  // Fraction shorthand: "3/4", "-1/3", "22/7"
  const fractionPattern = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/;
  const fractionMatch = fractionPattern.exec(s);
  if (fractionMatch) {
    return parseFraction(Number(fractionMatch[1]), Number(fractionMatch[2]));
  }

  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/**
 * Computes the decimal result of numerator / denominator.
 * Returns null if the denominator is zero or the result is non-finite.
 */
export function parseFraction(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}
