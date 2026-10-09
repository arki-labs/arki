import { describe, expect, it } from 'vitest';

import { lines, paragraphCount, paragraphs, sentenceCount, sentences, wordCount, words } from './segment.js';

describe('lines', () => {
  it('handles every line terminator and keeps trailing empties', () => {
    expect(lines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c', '']);
    expect(lines('')).toEqual(['']);
    expect(lines('x\u2028y\u0085z')).toEqual(['x', 'y', 'z']);
  });
});

describe('words / wordCount', () => {
  it('counts prose words', () => {
    expect(words("don't re-enter 3.14")).toEqual(["don't", 're-enter', '3.14']);
    expect(wordCount("don't re-enter 3.14")).toBe(3);
    expect(wordCount('你好世界')).toBe(1);
    expect(wordCount('')).toBe(0);
    expect(wordCount('— … !!')).toBe(0);
    expect(words('crème brûlée, s’il vous plaît')).toEqual(['crème', 'brûlée', 's’il', 'vous', 'plaît']);
    expect(words('a - b')).toEqual(['a', 'b']);
  });
});

describe('sentences / sentenceCount', () => {
  it('splits on terminal punctuation followed by whitespace or the end', () => {
    expect(sentences('One. Two! Three? Four… "Five." Six')).toEqual([
      'One.',
      'Two!',
      'Three?',
      'Four…',
      '"Five."',
      'Six',
    ]);
  });

  it('keeps decimals and punctuation runs together and ignores fragments without words', () => {
    expect(sentences('Pi is 3.14. Really?! Yes...  ')).toEqual(['Pi is 3.14.', 'Really?!', 'Yes...']);
    expect(sentences('')).toEqual([]);
    expect(sentences('... !!! ???')).toEqual([]);
    expect(sentenceCount('A dog. A cat.\nA bird')).toBe(3);
  });
});

describe('paragraphs / paragraphCount', () => {
  it('counts non-blank lines whatever the line-break style', () => {
    expect(paragraphs('First.\n\nSecond.\r\n  \r\nThird.')).toEqual(['First.', 'Second.', 'Third.']);
    expect(paragraphCount('a\nb\nc')).toBe(3);
    expect(paragraphCount('\n\n  \n')).toBe(0);
  });
});

describe('sentences stays linear on long punctuation runs', () => {
  it('handles 50k terminal marks without backtracking', () => {
    const text = '!'.repeat(50_000) + 'x';
    const started = performance.now();
    expect(sentences(text)).toEqual([text]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('keeps closing quotes with the sentence and needs whitespace after them', () => {
    expect(sentences('He said "stop." She left.')).toEqual(['He said "stop."', 'She left.']);
    expect(sentences('v1.2.3 shipped')).toEqual(['v1.2.3 shipped']);
  });
});
