import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { JsonLdScript } from './json-ld-script';

describe('JsonLdScript', () => {
  it('renders a script tag with application/ld+json type', () => {
    const html = renderToStaticMarkup(
      <JsonLdScript
        id="test"
        data={{ '@context': 'https://schema.org', '@type': 'Organization', name: 'Test' }}
      />,
    );
    expect(html).toContain('type="application/ld+json"');
    expect(html).toContain('id="test"');
  });

  it('escapes < characters to prevent XSS', () => {
    const html = renderToStaticMarkup(
      <JsonLdScript
        id="test"
        data={{
          '@context': 'https://schema.org',
          '@type': 'Organization',
          name: '</script><script>alert(1)</script>',
        }}
      />,
    );
    expect(html).not.toContain('</script><script>');
    expect(html).toContain('\\u003c');
  });

  it('produces valid JSON in the output', () => {
    const html = renderToStaticMarkup(
      <JsonLdScript
        id="test"
        data={{
          '@context': 'https://schema.org',
          '@type': 'WebSite',
          name: 'My Site',
          url: 'https://example.com',
        }}
      />,
    );
    const match = html.match(/>(.+?)<\/script>/);
    expect(match).toBeTruthy();
    // After unescaping \u003c back to <, the JSON should parse correctly
    const jsonStr = match![1]!.replace(/\\u003c/g, '<');
    const parsed = JSON.parse(jsonStr);
    expect(parsed['@context']).toBe('https://schema.org');
    expect(parsed['@type']).toBe('WebSite');
    expect(parsed.name).toBe('My Site');
  });
});
