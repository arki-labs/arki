import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ArticleSchema } from './article-schema';

describe('ArticleSchema with an Invalid Date', () => {
  // Why: toISOString() throws on an Invalid Date and would fail the whole page render.
  const article = {
    title: 'T',
    description: 'D',
    url: '/a',
    author: { name: 'Ada' },
    image: 'https://example.com/i.png',
    publishedAt: new Date('2026-01-02T03:04:05Z'),
  };

  it('renders without dateModified when modifiedAt is invalid, falling back to publishedAt', () => {
    const html = renderToStaticMarkup(
      <ArticleSchema
        article={{ ...article, modifiedAt: new Date('nope') }}
        siteName="S"
        siteUrl="https://example.com"
      />,
    );
    expect(html).toContain('"dateModified":"2026-01-02T03:04:05.000Z"');
  });

  it('renders without datePublished when publishedAt is invalid', () => {
    const html = renderToStaticMarkup(
      <ArticleSchema
        article={{ ...article, publishedAt: new Date('nope') }}
        siteName="S"
        siteUrl="https://example.com"
      />,
    );
    expect(html).not.toContain('datePublished');
  });
});
