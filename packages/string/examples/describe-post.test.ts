import { describe, expect, it } from 'vitest';

import { describePost } from './describe-post.js';

describe('describePost', () => {
  it('builds the slug, a word-boundary summary and a reading time for a blog index', () => {
    const body = 'We moved the ledger to a new   database last week.\n\nThe move took two hours, and nobody noticed.';
    expect(describePost('Café Guide & Notes', body)).toEqual({
      slug: 'cafe-guide-and-notes',
      summary: 'We moved the ledger to a new database last week. The move…',
      minutes: 1,
    });
  });

  it('keeps a short body whole and never reports less than one minute', () => {
    expect(describePost('Hi', 'short')).toEqual({ slug: 'hi', summary: 'short', minutes: 1 });
  });
});
