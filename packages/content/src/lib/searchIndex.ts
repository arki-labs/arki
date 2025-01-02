import { mkdir, writeFile } from "node:fs/promises";
import MiniSearch from "minisearch";
import path from "node:path";
import searchOptions from "./search";
import type { Post } from '../collections/post';


export default async function searchIndex(posts: Post[], outputPath: string) {
  if (posts.length === 0) {
    return;
  }

  const miniSearch = new MiniSearch(searchOptions);
  // Index all documents
  miniSearch.addAll(posts.map((post) => ({ ...post, content: post.content.raw })));

  const data = miniSearch.toJSON();

  const directory = path.join(outputPath, "Post");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "search-index.json"), JSON.stringify(data), {
    encoding: "utf8",
  });
}
