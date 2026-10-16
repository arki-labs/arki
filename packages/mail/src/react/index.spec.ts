// Apps with React Email components render them through `renderReact`; a mail needs both parts,
// and the plain-text part must be real text, not HTML.
import { createElement } from 'react';
import { Html, Link, Text } from 'react-email';
import { describe, expect, it } from 'vitest';

import { renderReact } from './index.js';

// Built with `createElement`: this package's tsconfig keeps JSX as-is (`jsx: preserve`), so the
// default vitest transform cannot load the `.tsx` templates.
const email = createElement(
  Html,
  null,
  createElement(Text, null, 'Sign in to Notes'),
  createElement(Link, { href: 'https://notes.example.com/login?t=1' }, 'https://notes.example.com/login?t=1'),
);

describe('renderReact', () => {
  it('returns the HTML document and a plain-text part with the same content', async () => {
    const { html, text } = await renderReact(email);
    expect(html).toMatch(/^<!DOCTYPE html/i);
    expect(html).toContain('Notes');
    expect(text).toContain('Notes');
    expect(text).toContain('https://notes.example.com/login?t=1');
    expect(text).not.toMatch(/<[a-z][^>]*>/i);
  });
});
