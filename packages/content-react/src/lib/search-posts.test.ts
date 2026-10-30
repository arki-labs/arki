import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';

import type { PostOverview } from '@arki/content';
import { isFailure } from '@arki/failure';

import type { postOverviewSchema } from './search-posts';
import { searchPosts, SearchResponseMalformed, SearchUnavailable } from './search-posts';

const post = {
  url: '/posts/a',
  title: 'A',
  description: 'About a',
  publishedAt: '2026-10-01T00:00:00.000Z',
  readingTime: '2 min',
  image: { url: '/a.png' },
};

const answer = (body: BodyInit, init?: ResponseInit): typeof fetch => () => Promise.resolve(new Response(body, init));

describe('searchPosts', () => {
  it('locks the response schema to the PostOverview type', () => {
    expectTypeOf<z.output<typeof postOverviewSchema>>().toEqualTypeOf<PostOverview>();
  });

  it('parses the JSON body and turns the date text back into a Date', async () => {
    const outcome = await searchPosts('a', new AbortController().signal, answer(JSON.stringify([post])));
    expect(isFailure(outcome)).toBe(false);
    expect(outcome).toEqual([{ ...post, publishedAt: new Date(post.publishedAt) }]);
  });

  it('returns SearchUnavailable with the status for a non-ok answer', async () => {
    const outcome = await searchPosts('a', new AbortController().signal, answer('nope', { status: 500 }));
    expect(SearchUnavailable.is(outcome)).toBe(true);
    expect(isFailure(outcome) && outcome.cause).toBe(500);
  });

  it('returns SearchUnavailable when the network fails', async () => {
    const outcome = await searchPosts('a', new AbortController().signal, () => Promise.reject(new TypeError('offline')));
    expect(SearchUnavailable.is(outcome)).toBe(true);
  });

  it('returns SearchResponseMalformed for a body that is not JSON', async () => {
    const outcome = await searchPosts('a', new AbortController().signal, answer('<html>'));
    expect(SearchResponseMalformed.is(outcome)).toBe(true);
  });

  it('returns SearchResponseMalformed for JSON of the wrong shape instead of trusting it', async () => {
    const outcome = await searchPosts('a', new AbortController().signal, answer(JSON.stringify([{ url: 1 }])));
    expect(SearchResponseMalformed.is(outcome)).toBe(true);
  });
});
