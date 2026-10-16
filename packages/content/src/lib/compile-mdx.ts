import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CollectionContext, Meta } from '@content-collections/core';
import type { Options as MdxOptions } from '@content-collections/mdx';
import { compileMDX as compileUpstreamMDX } from '@content-collections/mdx';

type MdxDocument = { _meta: Meta; content: string };
type FileAppender = Parameters<NonNullable<MdxOptions['files']>>[0];

/** Every file below `directory`, sorted so the hash does not depend on read order. */
async function filesBelow(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath, entry.name))
    .toSorted();
}

/** Runs `options.files` against a recording appender: the files upstream will add to the bundle. */
function appendedFiles(options: MdxOptions | undefined): {
  contents: string[];
  paths: string[];
  directories: string[];
} {
  const appended = { contents: new Array<string>(), paths: new Array<string>(), directories: new Array<string>() };
  const appender: FileAppender = {
    content: (importPath, content) => {
      appended.contents.push(`${importPath}\n${content}`);
    },
    file: (_importPath, filePath) => {
      appended.paths.push(filePath);
    },
    directory: (_importPath, directoryPath) => {
      appended.directories.push(directoryPath);
    },
  };
  options?.files?.(appender);
  return appended;
}

/**
 * Upstream keys compiled MDX on the document text alone. This hash adds what else changes the output: the options
 * (plugin names and their settings), the appended files, and every file in the document's own folder (its images
 * and components). Code changes inside `@arki/content` plugins are not seen: clear `.content-collections/cache`.
 */
async function fingerprint(collectionDirectory: string, document: MdxDocument, options?: MdxOptions): Promise<string> {
  const hash = createHash('sha256');
  hash.update(
    JSON.stringify(options ?? {}, (_key, value: unknown) => (typeof value === 'function' ? `fn:${value.name}` : value)),
  );

  const appended = appendedFiles(options);
  const files = [...appended.paths];
  for (const directory of appended.directories) files.push(...(await filesBelow(directory)));
  if (document._meta.directory !== '.') {
    files.push(...(await filesBelow(path.join(collectionDirectory, document._meta.directory))));
  }

  for (const content of appended.contents) hash.update(content);
  for (const file of files) {
    hash.update(file);
    hash.update(existsSync(file) ? await readFile(file) : '');
  }
  return hash.digest('hex');
}

/** `compileMDX` from `@content-collections/mdx`, with a cache key that changes when images, components or options do. */
export async function compileMDX(
  context: Pick<CollectionContext, 'cache' | 'collection'>,
  document: MdxDocument,
  options?: MdxOptions,
): Promise<string> {
  const salt = await fingerprint(context.collection.directory, document, options);
  const cache: CollectionContext['cache'] = (input, compute, cacheOptions) =>
    context.cache({ input, salt }, salted => compute(salted.input), cacheOptions);
  return compileUpstreamMDX({ cache }, document, options);
}
