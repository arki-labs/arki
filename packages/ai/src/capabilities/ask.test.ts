import { describe, expect, it } from 'vitest';

import { askCitationLabels, askPassages, askQuestionSchema } from './ask';

describe('Ask evidence retrieval', () => {
  it('renders echoed source IDs as measured timestamps and rejects unknown references', () => {
    expect(askCitationLabels('Three prompts [source_18].', [{ id: 'source_18', start: 86.28 }])).toBe(
      'Three prompts [1:26].',
    );
    expect(() => askCitationLabels('A claim [source_19].', [{ id: 'source_18', start: 86.28 }])).toThrow();
  });
  it('keeps the capture context and distant matching evidence without inventing source text or timing', () => {
    const segments = Array.from({ length: 150 }, (_, i) => ({
      start: i * 4,
      end: i * 4 + 4,
      text: i === 145 ? 'Photosynthesis uses light.' : `Source sentence ${i}.`,
    }));
    const passages = askPassages(
      { language: 'en', segments },
      { at: 24, question: 'Explain photosynthesis', history: [] },
    );
    expect(passages).toHaveLength(30);
    expect(passages.some(p => p.start <= 24 && p.end >= 24)).toBe(true);
    expect(passages.some(p => p.text.includes('Photosynthesis uses light.'))).toBe(true);
    for (const p of passages) {
      expect(p.text).toBe(
        segments
          .filter(s => s.start >= p.start && s.end <= p.end)
          .map(s => s.text)
          .join(' '),
      );
    }
  });
  it('rejects unbounded or ambiguous request envelopes before provider work', () => {
    expect(askQuestionSchema.safeParse({ question: ' ', at: 5 }).success).toBe(false);
    expect(askQuestionSchema.safeParse({ question: 'Why?', at: -1 }).success).toBe(false);
    expect(askQuestionSchema.safeParse({ question: 'Why?', at: 5, sourceHash: 'other edition' }).success).toBe(false);
  });
});
