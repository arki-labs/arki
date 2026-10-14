/**
 * Input syntax (RFC §5) is explicit, never sniffed. Two presets cover every
 * locale: `canonical` (`0.5`, `log(x, 2)`) and `decimalComma` (`0,5`,
 * `log(x; 2)`). Storage is always canonical; see `print`.
 */
import { InvalidArgumentError, UnsupportedFeatureError } from '@arki/math/errors';

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
 * Validates a syntax and returns it frozen. Throws `InvalidArgumentError` for
 * an unknown mark or for a decimal comma with a `,` separator.
 */
export function defineSyntax(definition: SyntaxDefinition): Syntax {
  // Typed callers cannot pass anything else; JavaScript callers and stored settings can.
  const decimal: unknown = definition.decimal;
  const separator: unknown = definition.separator;
  if (separator !== ',' && separator !== ';') {
    throw new InvalidArgumentError(`Unknown argument separator ${JSON.stringify(separator)}; use "," or ";"`);
  }
  if (decimal === '.') return Object.freeze({ decimal, separator });
  if (decimal === ',') {
    if (separator === ',') {
      throw new InvalidArgumentError(
        'A decimal comma needs the ";" argument separator: "1,5" cannot also split arguments',
      );
    }
    return Object.freeze({ decimal, separator });
  }
  throw new InvalidArgumentError(`Unknown decimal mark ${JSON.stringify(decimal)}; use "." or ","`);
}

/**
 * The preset for a locale: `decimalComma` where the locale writes `1,5`,
 * `canonical` otherwise. Calls `Intl` only when invoked, never at module load.
 *
 * Runtimes without `Intl.NumberFormat#formatToParts` (React Native's Hermes on
 * iOS) throw `UnsupportedFeatureError`; pass a preset instead.
 */
export function syntaxFor(locale?: string | readonly string[]): Syntax {
  const formatter = new Intl.NumberFormat(
    locale === undefined ? undefined : typeof locale === 'string' ? locale : [...locale],
  );
  // React Native's Hermes on Apple platforms has Intl.NumberFormat but no formatToParts.
  if (typeof formatter.formatToParts !== 'function') {
    throw new UnsupportedFeatureError(
      "This runtime lacks Intl.NumberFormat#formatToParts, which syntaxFor needs (React Native's Hermes on iOS); pass a syntax preset instead",
    );
  }
  const mark = formatter.formatToParts(1.5).find(part => part.type === 'decimal')?.value;
  return mark === ',' ? decimalComma : canonical;
}
