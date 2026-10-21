import { describe, expect, it } from 'vitest';

import { newerDocs, wrapCheckSection } from './-doc-page';

describe('newerDocs', () => {
  const published = { status: 'published', npmVersion: '0.6.1', nextVersion: null } as const;
  const candidate = { status: 'next', npmVersion: '0.6.1', nextVersion: '0.7.0' } as const;

  it('points an older folder to the newest one', () => {
    expect(newerDocs(published, '0.5.0')).toEqual({ folder: '0.6.1', version: '0.6.1' });
    expect(newerDocs(candidate, '0.6.1')).toEqual({ folder: 'next', version: '0.7.0' });
  });

  it('says nothing on the newest folder or for a package with no docs', () => {
    expect(newerDocs(published, '0.6.1')).toBeNull();
    expect(newerDocs(candidate, 'next')).toBeNull();
    expect(newerDocs({ status: 'none', npmVersion: null, nextVersion: null }, '0.1.0')).toBeNull();
  });
});

describe('wrapCheckSection', () => {
  it('wraps only the Check it section, up to the next h2', () => {
    const html = '<h2 id="steps">Steps</h2><ol></ol><h2 id="check-it">Check it</h2><p>run</p><pre>x</pre>';
    expect(wrapCheckSection(html)).toBe(
      '<h2 id="steps">Steps</h2><ol></ol><section class="doc-check"><h2 id="check-it">Check it</h2><p>run</p><pre>x</pre></section>',
    );
    expect(wrapCheckSection('<h2 id="a">Checks</h2><p>x</p>')).toBe('<h2 id="a">Checks</h2><p>x</p>');
  });
});
