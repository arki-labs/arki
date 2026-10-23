import { z } from 'zod';

import { assert } from '@arki/schema';

import { withOptionsJson } from './schemas.js';

/** Options of {@link normalizeText}. */
export type NormalizeTextOptions = {
  /**
   * Replace the legacy cedilla letters with Romanian's comma-below ones: ş→ș, ţ→ț, Ş→Ș, Ţ→Ț. Text
   * typed on old keyboards mixes both, and a model sees them as different characters.
   */
  readonly romanianDiacritics?: boolean;
};

/** `NormalizeTextOptions`, checked by `normalizeText`; a type test locks it to the type. */
export const normalizeTextOptionsSchema = withOptionsJson(z.object({ romanianDiacritics: z.boolean().optional() }).readonly());

/** Cedilla letter → comma-below letter. Read after NFC, which composes `s` + U+0327 into `ş`. */
const COMMA_BELOW: Readonly<Record<string, string>> = { ş: 'ș', ţ: 'ț', Ş: 'Ș', Ţ: 'Ț' };

/**
 * Puts text in one form before you embed or store it: Unicode NFC, every run of whitespace as one
 * space, no space at either end, and, when asked, Romanian comma-below letters. The embedder never
 * calls it: it sends your text exactly as given, so call this yourself, on documents and queries alike.
 *
 * @example
 * normalizeText('  Ştefan   şi\nţara ', { romanianDiacritics: true }); // 'Ștefan și țara'
 */
export function normalizeText(text: string, options: NormalizeTextOptions = {}): string {
  assert(options, normalizeTextOptionsSchema, { at: 'normalizeText options' });
  const collapsed = text.normalize('NFC').replaceAll(/\s+/g, ' ').trim();
  return options.romanianDiacritics === true
    ? collapsed.replaceAll(/[şţ]/gi, letter => COMMA_BELOW[letter] ?? letter)
    : collapsed;
}
