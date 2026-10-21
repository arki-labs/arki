import { describe, expect, it } from 'vitest';

import { demoteHeadings } from './-demote-headings';

describe('demoteHeadings', () => {
  // WHY: /agents has its own h1; the protocol's title must not become a second one (one h1 per page for screen readers).
  it('moves each heading one level down', () => {
    expect(demoteHeadings('# Title\n\ntext\n\n## Part\n')).toBe('## Title\n\ntext\n\n### Part\n');
  });

  // A `#` comment inside a code block is code, not a heading.
  it('leaves fenced code alone', () => {
    expect(demoteHeadings('```sh\n# install\n```\n# Title')).toBe('```sh\n# install\n```\n## Title');
  });
});
