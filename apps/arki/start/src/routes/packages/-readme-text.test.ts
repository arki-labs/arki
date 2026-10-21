import { describe, expect, it } from 'vitest';

import { readmePurpose, withoutLeadingTitle } from './-readme-text';

describe('readmePurpose', () => {
  // The index promises a purpose line taken from the README itself: one sentence, readable as plain text.
  it('returns the first sentence of the first paragraph as plain text', () => {
    const html =
      '<h1>@arki/money</h1><p>Exact, fast money for every JavaScript runtime. Units are numbers.</p><p>Second.</p>';
    expect(readmePurpose(html)).toBe('Exact, fast money for every JavaScript runtime.');
  });

  // Dot opens with a blockquote tagline; it is still the README's first paragraph and the best summary.
  it('reads a paragraph inside a blockquote', () => {
    const html = '<h1>@arki/dot</h1><blockquote>\n<p>Compose an app from typed plugins. The compiler checks.</p>\n</blockquote>';
    expect(readmePurpose(html)).toBe('Compose an app from typed plugins.');
  });

  // Inline code and entities must not leak markup or escapes into the table cell.
  it('strips tags and decodes entities', () => {
    const html = '<p>Two checks, <code>isURL</code> &amp; <code>isBase64</code>, built on &#x60;validator&#96;.</p>';
    expect(readmePurpose(html)).toBe('Two checks, isURL & isBase64, built on `validator`.');
  });

  // A badge row is a paragraph with no text; using it would show an empty purpose.
  it('skips paragraphs without text', () => {
    const html = '<p><img src="badge.svg" alt=""></p><p>Typed HTTP for apps</p>';
    expect(readmePurpose(html)).toBe('Typed HTTP for apps');
  });

  // Never invent a purpose: no paragraph means no line.
  it('returns null when the README has no paragraph', () => {
    expect(readmePurpose('<h1>@arki/x</h1><pre><code>bun add</code></pre>')).toBeNull();
  });
});

describe('withoutLeadingTitle', () => {
  // The page renders its own H1; keeping the README's would give the page two H1s.
  it('drops only the leading h1', () => {
    expect(withoutLeadingTitle('<h1 id="arkidot">@arki/dot</h1>\n<p>Body</p><h1>Later</h1>')).toBe(
      '<p>Body</p><h1>Later</h1>',
    );
  });

  it('leaves HTML without a leading h1 alone', () => {
    expect(withoutLeadingTitle('<p>Body</p><h1>Later</h1>')).toBe('<p>Body</p><h1>Later</h1>');
  });
});
