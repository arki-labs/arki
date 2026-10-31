import { describe, expect, it } from 'vitest';

import { compileMarkdown } from './compile-markdown.js';

describe('compileMarkdown', () => {
  it('gives headings the ids GitHub gives them, so deep links to a doc keep working on the site', async () => {
    // Package docs link to each other with `#anchor` fragments written against GitHub. Different ids would break them.
    const { html, headings } = await compileMarkdown('# Quick start\n\n## Install it!\n\n## Install it!\n');

    expect(headings).toEqual([
      { depth: 1, text: 'Quick start', id: 'quick-start' },
      { depth: 2, text: 'Install it!', id: 'install-it' },
      { depth: 2, text: 'Install it!', id: 'install-it-1' },
    ]);
    expect(html).toContain('<h2 id="install-it-1"');
  });

  it('keeps heading text free of the autolink anchor, so a table of contents shows clean titles', async () => {
    const { html, headings } = await compileMarkdown('## Error `E_DOT_CYCLE`\n');

    expect(headings).toEqual([{ depth: 2, text: 'Error E_DOT_CYCLE', id: 'error-e_dot_cycle' }]);
    expect(html).toContain('href="#error-e_dot_cycle"');
  });

  it('keeps `<` and `{` in prose as text, which an MDX compile would reject or swallow', async () => {
    // Package docs are plain markdown written for GitHub: comparisons and object literals appear in sentences.
    const { html } = await compileMarkdown('Retries when a < b and returns { ok: true }.\n');

    expect(html).toContain('Retries when a &#x3C; b and returns { ok: true }.');
  });

  it('highlights fenced code blocks', async () => {
    const { html } = await compileMarkdown('```ts\nconst answer = 42;\n```\n');

    expect(html).toContain('data-rehype-pretty-code-figure');
    expect(html).toContain('data-language="ts"');
    expect(html).toContain('--shiki-dark');
  });

  it('renders GitHub tables and keeps raw HTML that READMEs use', async () => {
    const { html } = await compileMarkdown(
      '| a | b |\n| - | - |\n| 1 | 2 |\n\n<details><summary>More</summary>\n\nHidden.\n\n</details>\n',
    );

    expect(html).toContain('<table>');
    expect(html).toContain('<summary>More</summary>');
  });

  it('rewrites, drops or keeps links as `rewriteLink` says, so relative doc links can point at site URLs', async () => {
    const { html } = await compileMarkdown('[a](./a.md) [b](../outside.md) [c](https://example.com)\n', {
      rewriteLink: href => {
        if (href === './a.md') return '/docs/a';
        if (href.startsWith('../')) return null;
        return;
      },
    });

    expect(html).toContain('<a href="/docs/a">a</a>');
    expect(html).toContain(' b ');
    expect(html).not.toContain('outside.md');
    expect(html).toContain('<a href="https://example.com">c</a>');
  });

  // Markdown from outside (a README, a comment, a feed) can carry HTML. It must not run script in a reader's page.
  it('strips script, event handlers and javascript: links from raw HTML by default', async () => {
    const { html } = await compileMarkdown(
      '<script>alert(1)</script>\n\n<img src="x.png" onerror="alert(2)">\n\n<a href="javascript:alert(3)">go</a>\n',
    );

    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<img src="x.png"');
  });

  it('keeps harmless raw HTML and the ids this package adds to headings when sanitizing', async () => {
    const { html } = await compileMarkdown('## Intro\n\n<details><summary>More</summary>Hidden text</details>\n');

    expect(html).toContain('<details><summary>More</summary>Hidden text</details>');
    expect(html).toContain('<h2 id="intro"');
  });

  it('keeps raw HTML as written when the caller marks the markdown as trusted', async () => {
    const { html } = await compileMarkdown('<div onclick="x()">own team</div>\n', { trustedHtml: true });

    expect(html).toContain('<div onclick="x()">own team</div>');
  });
});

