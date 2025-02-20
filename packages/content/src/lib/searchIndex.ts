import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import MiniSearch from 'minisearch';

import type { Post } from '../collections/post';
import searchOptions from './search';

export default async function searchIndex(posts: Post[], outputPath: string) {
  if (posts.length === 0) {
    return;
  }

  const miniSearch = new MiniSearch(searchOptions);
  // Index all documents
  miniSearch.addAll(posts.map(post => ({ ...post, content: post.content.raw })));

  const data = miniSearch.toJSON();

  const directory = path.join(outputPath, 'Post');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'search-index.json'), JSON.stringify(data), {
    encoding: 'utf8',
  });
}
