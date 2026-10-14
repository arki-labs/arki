import { describe, expect, it } from 'vitest';

import type { Post } from './index';
import { createPostSearchIndex, loadPostSearchIndex, searchPosts } from './index';

function post(slug: string, fields: Partial<Pick<Post, 'title' | 'description' | 'tags'>> & { body: string }): Post {
  return {
    title: fields.title ?? slug,
    description: fields.description ?? '',
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    author: { name: 'Ada' },
    tags: fields.tags ?? [],
    content: { mdx: '', raw: fields.body },
    readingTime: '1 min read',
    lastModification: '2026-01-01T00:00:00.000Z',
    image: { url: '', blurDataURL: '' },
    url: `/posts/${slug}`,
    slug,
    _meta: { directory: slug, fileName: 'index.mdx', filePath: `${slug}/index.mdx`, extension: 'mdx', path: slug },
  };
}

// One post per field, so the boosts decide the order: tags 1.8 > title 1.6 > description 1.2 > body 1.
const corpus = [
  post('in-body', { title: 'Weekly notes', body: 'we looked at widgets this week' }),
  post('in-description', { title: 'Another note', description: 'all about widgets', body: 'nothing here' }),
  post('in-title', { title: 'Widgets', body: 'nothing here' }),
  post('in-tags', { title: 'Tagged', tags: ['widgets'], body: 'nothing here' }),
  post('unrelated', { title: 'Gadgets', body: 'something else entirely' }),
];

describe('post search ranking', () => {
  it('ranks a tag match over a title match over a description match over a body match', () => {
    const results = searchPosts(createPostSearchIndex(corpus), 'widgets');
    expect(results.map(result => result.id)).toEqual([
      '/posts/in-tags',
      '/posts/in-title',
      '/posts/in-description',
      '/posts/in-body',
    ]);
  });

  it('returns only the stored overview fields', () => {
    const [first] = searchPosts(createPostSearchIndex(corpus), 'widgets');
    expect(first?.title).toBe('Tagged');
    expect(first).not.toHaveProperty('tags');
    expect(first).not.toHaveProperty('content');
  });

  it('searches the raw body, not the compiled MDX', () => {
    const compiled = { ...post('compiled', { body: 'plain words' }), content: { mdx: 'zebra', raw: 'plain words' } };
    const index = createPostSearchIndex([compiled]);
    expect(searchPosts(index, 'zebra')).toEqual([]);
    expect(searchPosts(index, 'plain')).toHaveLength(1);
  });

  it('finds nothing for an unknown word', () => {
    expect(searchPosts(createPostSearchIndex(corpus), 'nonexistent')).toEqual([]);
  });

  it('keeps the same ranking after a JSON round trip, as the build writes it', () => {
    const json = JSON.stringify(createPostSearchIndex(corpus));
    const order = searchPosts(loadPostSearchIndex(json), 'widgets').map(result => result.id);
    expect(order[0]).toBe('/posts/in-tags');
    expect(order).toHaveLength(4);
  });
});
