import { describe, expect, it } from 'vitest';

import { isFailure } from '@arki/failure';

import type { NativeRequest } from './types.js';
import { embed } from './embed.js';
import { createEmbedder } from './embedder.js';
import { normalizeText } from './normalize.js';
import { echoTexts, stubModel } from './tests/stub-model.js';

describe('normalizeText', () => {
  // Romanian text mixes the legacy cedilla letters with the correct comma-below ones; only a caller
  // who knows the text is Romanian may merge them (ş is also Turkish).
  it('cedilla becomes comma-below only when asked', () => {
    const text = 'Ştefan şi Ţara ţării';
    expect(normalizeText(text, { romanianDiacritics: true })).toBe('Ștefan și Țara țării');
    expect(normalizeText(text)).toBe(text);
  });

  it('composes to NFC and collapses whitespace', () => {
    expect(normalizeText('  şi\n\n\tcafé  ', { romanianDiacritics: true })).toBe('și café');
  });

  // Cache keys (slice 2) hash the text the provider got; the library must never rewrite it behind the caller.
  it('embedder sends the exact text', async () => {
    const sent: string[] = [];
    const embedder = createEmbedder(
      stubModel((request: NativeRequest) => {
        sent.push(...request.texts);
        return echoTexts(request);
      }),
    );
    if (isFailure(embedder)) throw new Error(embedder.message);
    const text = '  Ştefan  şi\tcafé ';
    await embed(embedder, text);
    expect(sent).toEqual([text]);
  });
});
