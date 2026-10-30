import { describe, expect, it } from 'vitest';

import { collapseWhitespace, dedent, excerpt, initials, squish, truncate, wrapText } from './format.js';

describe('whitespace', () => {
  it('collapseWhitespace keeps one leading/trailing space', () => {
    expect(collapseWhitespace(' \tA\r\n B\u00A0 ')).toBe(' A B ');
  });
  it('squish', () => {
    expect(squish(' \tA\r\n B\u00A0 ')).toBe('A B');
    expect(squish(squish('  a   b  '))).toBe(squish('  a   b  '));
  });
  it('does not strip zero-width characters', () => {
    expect(squish('a\u200Bb')).toBe('a\u200Bb');
  });
});

describe('initials', () => {
  it('picks first and last by default', () => {
    expect(initials(' Ada   Lovelace ')).toBe('AL');
    expect(initials('Ada King Lovelace')).toBe('AL');
    expect(initials('Ada King Lovelace', { pick: 'first' })).toBe('AK');
    expect(initials('Ada King Lovelace', { max: 3 })).toBe('AKL');
    expect(initials('ada')).toBe('A');
    expect(initials('')).toBe('');
    expect(initials('émile zola')).toBe('ÉZ');
    expect(initials('👩‍💻 dev')).toBe('👩‍💻D');
    expect(() => initials('x', { max: 0 })).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('truncate', () => {
  it('enforces a total grapheme budget', () => {
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 1)).toBe('…');
    expect(truncate('abcdef', 0)).toBe('');
    expect(truncate('abcd', 4)).toBe('abcd');
    expect(truncate('abcdef', 5, { ellipsis: '...' })).toBe('ab...');
    expect(truncate('abcdef', 2, { ellipsis: '...' })).toBe('..');
    expect(truncate('👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦', 2)).toBe('👨‍👩‍👧‍👦…');
    expect(() => truncate('x', -1)).toThrowError(/ARKI_STRING_E001/);
  });
  it('backs up to a word boundary', () => {
    expect(truncate('alpha beta', 8, { boundary: 'word-before' })).toBe('alpha…');
    expect(truncate('alpha beta gamma', 11, { boundary: 'word-before' })).toBe('alpha beta…');
    expect(truncate('alphabetagamma', 6, { boundary: 'word-before' })).toBe('alpha…');
  });
});

describe('excerpt', () => {
  const text = 'The quick brown fox jumps over the lazy dog';
  it('returns context around the match', () => {
    expect(excerpt(text, 'fox', { radius: 6 })).toBe('…brown fox jumps…');
    expect(excerpt(text, 'The', { radius: 5 })).toBe('The quic…');
    expect(excerpt(text, 'dog', { radius: 5 })).toBe('…lazy dog');
    expect(excerpt(text, 'cat')).toBeUndefined();
    expect(excerpt(text, 'fox')).toBe(text);
    expect(excerpt('é', 'e')).toBeUndefined();
    expect(() => excerpt(text, '')).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('wrapText', () => {
  it('wraps greedily and keeps existing breaks', () => {
    expect(wrapText('the quick brown fox', 10)).toBe('the quick\nbrown fox');
    expect(wrapText('a\n\nb', 10)).toBe('a\n\nb');
    expect(wrapText('supercalifragilistic', 5)).toBe('supercalifragilistic');
    expect(wrapText('supercalifragilistic', 5, { breakWords: true })).toBe('super\ncalif\nragil\nistic');
    expect(wrapText('a b', 1, { newline: '<br>' })).toBe('a<br>b');
    expect(() => wrapText('x', 0)).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('truncate boundaries', () => {
  const text = 'First one. Second two! Third "three?" Fourth four and more.';

  it('never leaves whitespace before the ellipsis', () => {
    expect(truncate('hello world', 7)).toBe('hello…'); // grapheme cut would give "hello …"
    expect(truncate('hello world', 7, { ellipsis: '...' })).toBe('hell...');
  });

  it('sentence: backs up to the last sentence end that fits, closers included', () => {
    expect(truncate(text, 30, { boundary: 'sentence' })).toBe('First one. Second two!…');
    expect(truncate(text, 42, { boundary: 'sentence' })).toBe('First one. Second two! Third "three?"…');
  });

  it('sentence: falls back to a word boundary when no sentence end fits', () => {
    expect(truncate(text, 8, { boundary: 'sentence' })).toBe('First…');
    expect(truncate('3.14 is pi and more words here', 12, { boundary: 'sentence' })).toBe('3.14 is pi…');
  });
});

describe('excerpt boundaries', () => {
  const text = 'The cat sat. A quick brown fox jumps over the lazy dog. The end is near.';

  it('word: pulls both edges inward to word boundaries', () => {
    expect(excerpt(text, 'fox', { radius: 9, boundary: 'word' })).toBe('…brown fox jumps…');
    expect(excerpt(text, 'fox', { radius: 9 })).toBe('…ck brown fox jumps ov…');
  });

  it('sentence: snaps to the sentence containing the match when the radius allows', () => {
    // from = 2 and to = 55 in code units; the sentence runs 13..55.
    expect(excerpt(text, 'fox', { radius: 25, boundary: 'sentence' })).toBe(
      '…A quick brown fox jumps over the lazy dog.…',
    );
    expect(excerpt(text, 'fox', { radius: 60, boundary: 'sentence' })).toBe(text);
  });

  it('sentence: an edge with no sentence boundary in reach falls back to a word boundary', () => {
    // from = 7 → sentence start 13; to = 50 has no sentence end at or after the match → word end (50).
    expect(excerpt(text, 'fox', { radius: 20, boundary: 'sentence' })).toBe('…A quick brown fox jumps over the lazy…');
  });

  it('never moves an edge past the match', () => {
    expect(excerpt(text, 'fox', { radius: 1, boundary: 'sentence' })).toBe('…fox…'); // word fallback
    expect(excerpt(text, 'fox', { radius: 1, boundary: 'word' })).toBe('…fox…');
  });
});

describe('initials for a single word', () => {
  it('takes leading graphemes when asked', () => {
    expect(initials('Alex', { singleWord: 2 })).toBe('AL');
    expect(initials('émile', { singleWord: 2 })).toBe('ÉM');
    expect(initials('Alex Lee', { singleWord: 2 })).toBe('AL'); // two words: unchanged rule
    expect(initials('Alex')).toBe('A');
    expect(() => initials('Alex', { singleWord: 0 })).toThrowError(/ARKI_STRING_E001/);
  });
});

describe('dedent', () => {
  it('removes the shared indent and the surrounding blank lines', () => {
    const sql = dedent(`
      SELECT *
        FROM poems
       WHERE id = 1
    `);
    expect(sql).toBe('SELECT *\n  FROM poems\n WHERE id = 1');
  });

  it('works as a tag and keeps interior blank lines', () => {
    const name = 'Ada';
    expect(dedent`
      Hello ${name}

      Bye
    `).toBe('Hello Ada\n\nBye');
  });

  it('leaves text without indentation alone', () => {
    expect(dedent('a\nb')).toBe('a\nb');
    expect(dedent('')).toBe('');
  });
});

describe('truncate on long whitespace', () => {
  it('word-before and sentence cuts finish fast on 200,000 spaces', () => {
    const text = `${' '.repeat(200_000)}a bc`;
    for (const boundary of ['word-before', 'sentence'] as const) {
      const started = performance.now();
      const result = truncate(text, 200_003, { boundary });
      expect(performance.now() - started).toBeLessThan(500);
      expect(result.endsWith('…')).toBe(true);
    }
  });
  it('still backs up to the last whole word', () => {
    expect(truncate('one two three four', 12, { boundary: 'word-before' })).toBe('one two…');
    expect(truncate('one  two   three', 12, { boundary: 'word-before' })).toBe('one  two…');
  });
});

describe('malformed locale tags', () => {
  it('initials ignores the tag and keeps locale-independent casing', () => {
    expect(initials('ada lovelace', { locale: 'xx_yy' })).toBe(initials('ada lovelace'));
  });
});
