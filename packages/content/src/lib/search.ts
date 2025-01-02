import type { Options } from "minisearch";
import type { PostOverview } from "./types";
import type { Post } from '../collections/post';

const createSearchOptions = <T extends (keyof Post)[]>(
  idField: keyof Post,
  fields: T,
  storeFields: (keyof PostOverview)[],
  boost: Record<T[number], number>
): Options<PostOverview> => ({
  idField,
  fields,
  storeFields,
  searchOptions: {
    boost,
  },
});

const searchOptions = createSearchOptions(
  "url",
  ["title", "description", "content", "tags"],
  ["url", "title", "description", "publishedAt", "readingTime", "image"],
  {
    title: 1.6,
    description: 1.2,
    content: 1,
    tags: 1.8,
  }
);

export default searchOptions;
