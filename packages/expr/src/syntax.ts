/**
 * Input syntax (RFC §5) is explicit, never sniffed. Two presets cover every
 * locale: `canonical` (`0.5`, `log(x, 2)`) and `decimalComma` (`0,5`,
 * `log(x; 2)`). Storage is always canonical; see `print`.
 */
import { isFailure } from '@arki/failure';
import { InvalidArgumentError } from '@arki/math/errors';

import { InvalidLocale, InvalidSyntax } from './errors.js';

/** A valid syntax. A decimal comma always pairs with the `;` separator, so `f(1,5; 2)` is unambiguous. */
export type Syntax =
  { readonly decimal: '.'; readonly separator: ',' | ';' } | { readonly decimal: ','; readonly separator: ';' };

/** What `defineSyntax` accepts; it rejects `{ decimal: ',', separator: ',' }`. */
export type SyntaxDefinition = { readonly decimal: '.' | ','; readonly separator: ',' | ';' };

/** `.` decimals, `,` between arguments. The default, and the only storage syntax. */
export const canonical: Syntax = Object.freeze({ decimal: '.', separator: ',' });

/** `,` decimals, `;` between arguments (the spreadsheet convention of de, fr, ro, …). */
export const decimalComma: Syntax = Object.freeze({ decimal: ',', separator: ';' });

/**
 * Reads a syntax from a stored or untyped value (a user setting, JSON). Returns
 * the frozen syntax, or `InvalidSyntax` for an unknown mark or a decimal comma
 * with a `,` separator.
 */
export function parseSyntax(value: unknown) {
  if (typeof value !== 'object' || value === null) return InvalidSyntax();
  const decimal: unknown = 'decimal' in value ? value.decimal : undefined;
  const separator: unknown = 'separator' in value ? value.separator : undefined;
  if (separator !== ',' && separator !== ';') return InvalidSyntax();
  if (decimal === '.') {
    const syntax: Syntax = Object.freeze({ decimal, separator });
    return syntax;
  }
  if (decimal === ',' && separator === ';') {
    const syntax: Syntax = Object.freeze({ decimal, separator });
    return syntax;
  }
  return InvalidSyntax();
}

/**
 * Validates a syntax written in code and returns it frozen. The builder: it
 * throws `InvalidArgumentError` for a decimal comma with a `,` separator, or
 * for an unknown mark from an untyped caller. Stored settings go through
 * {@link parseSyntax}, which returns a failure instead.
 */
export function defineSyntax(definition: SyntaxDefinition): Syntax {
  const syntax = parseSyntax(definition);
  if (isFailure(syntax)) {
    throw new InvalidArgumentError(
      `${JSON.stringify(definition)} is not a syntax: use "." or "," as the decimal mark and "," or ";" between arguments; a decimal comma needs ";"`,
    );
  }
  return syntax;
}

/**
 * The preset for a locale: `decimalComma` where the locale writes `1,5`,
 * `canonical` otherwise. Calls `Intl` only when invoked, never at module load.
 * Returns `InvalidLocale` for a tag `Intl` rejects. Reads the mark from
 * `format`, which every runtime has, so React Native's Hermes on iOS (no
 * `formatToParts`) gets the same answer.
 */
export function syntaxFor(locale?: string | readonly string[]) {
  let formatted: string;
  try {
    formatted = new Intl.NumberFormat(
      locale === undefined ? undefined : typeof locale === 'string' ? locale : [...locale],
      { useGrouping: false },
    ).format(1.5);
  } catch {
    // Intl throws a RangeError (or a TypeError for a non-string entry) for a tag it rejects.
    return InvalidLocale();
  }
  return formatted.includes(',') ? decimalComma : canonical;
}
