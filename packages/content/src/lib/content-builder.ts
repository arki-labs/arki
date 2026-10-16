import { existsSync } from 'node:fs';
import path from 'node:path';
import type { AnyContent, Modification } from '@content-collections/core';
import { createBuilder } from '@content-collections/core';

import { getLogger } from '@arki/log';

const logger = getLogger('arki:content');

/** The config file every app keeps in its root folder, next to `package.json`. */
export const CONTENT_CONFIG_FILE = 'content.config.ts';

type ContentEmitter = NonNullable<Parameters<typeof createBuilder>[2]>;

/**
 * Works like the emitter `@content-collections/core` builds for itself (it does not export it). We pass our own so the
 * error listeners exist before `createBuilder` reads the files: upstream reads them inside `createBuilder`, and an
 * error emitted with no listener is lost and the document silently dropped.
 */
function createEmitter(): ContentEmitter {
  const listeners = new Map<string, ((event: object) => void)[]>();
  const notify = (key: string, event: object): void => {
    for (const listener of listeners.get(key) ?? []) listener(event);
  };
  return {
    on: (key: string, listener: (event: object) => void) => {
      listeners.set(key, [...(listeners.get(key) ?? []), listener]);
    },
    emit: (key: string, event: object) => {
      notify(key, event);
      if ('error' in event) notify('_error', { ...event, _event: key });
      notify('_all', { ...event, _event: key });
    },
  };
}

function documentPath(collection: AnyContent, file: string): string {
  return 'filePath' in collection ? collection.filePath : path.join(collection.directory, file);
}

/** Thrown by {@link ContentBuilder.build} when any content file failed. `problems` lists one line per file. */
export class ContentBuildError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`content build failed:\n${problems.map(problem => `  ${problem}`).join('\n')}`);
    this.name = 'ContentBuildError';
    this.problems = problems;
  }
}

/** What one build produced: counts and duration, for a log line. */
export type ContentBuildStats = { collections: number; documents: number; ms: number };

export type ContentBuilder = {
  /** Builds every collection. Rejects with {@link ContentBuildError} when a file failed to read, parse, validate or transform. */
  build: () => Promise<ContentBuildStats>;
  /**
   * Rebuilds after one file changed. A file in a document's own folder (a component, an image) rebuilds that
   * folder's `index.mdx`. Resolves with the problems found, so a dev server can show them and keep running.
   */
  sync: (modification: Modification, filePath: string) => Promise<readonly string[]>;
};

/** The `index.mdx` of the nearest folder above `filePath`, stopping at the app root. */
function ownerDocument(filePath: string, root: string): string | undefined {
  for (
    let directory = path.dirname(filePath);
    directory.startsWith(root + path.sep);
    directory = path.dirname(directory)
  ) {
    const candidate = path.join(directory, 'index.mdx');
    if (candidate !== filePath && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Reads `configPath` and returns a builder for it. The current folder must be the config's folder: collection
 * directories, copied images and git dates all resolve against it.
 */
export async function createContentBuilder(configPath: string): Promise<ContentBuilder> {
  const configFile = path.resolve(configPath);
  const root = path.dirname(configFile);
  if (root !== process.cwd()) {
    throw new Error(
      `@arki/content: run from ${root}, the folder of ${path.basename(configFile)} (the current folder is ${process.cwd()})`,
    );
  }

  const problems: string[] = [];
  const emitter = createEmitter();
  emitter.on('collector:read-error', ({ filePath, error }) => problems.push(`${filePath}: ${error.message}`));
  emitter.on('collector:parse-error', ({ filePath, error }) => problems.push(`${filePath}: ${error.message}`));
  emitter.on('transformer:validation-error', ({ collection, file, error }) =>
    problems.push(`${documentPath(collection, file.path)}: ${error.message}`),
  );
  emitter.on('transformer:error', ({ collection, error }) => problems.push(`${collection.name}: ${error.message}`));
  emitter.on('transformer:result-error', ({ collection, error }) =>
    problems.push(`${collection.name}: ${error.message}`),
  );
  emitter.on('watcher:config-reload-error', ({ error }) => problems.push(error.message));
  let lastBuild: ContentBuildStats = { collections: 0, documents: 0, ms: 0 };
  emitter.on('builder:end', ({ startedAt, endedAt, stats }) => {
    lastBuild = { ...stats, ms: endedAt - startedAt };
    logger.debug('built {collections} collections, {documents} documents in {ms}ms', lastBuild);
  });

  const builder = await createBuilder(configFile, undefined, emitter);
  const takeProblems = (): string[] => problems.splice(0);

  return {
    build: async () => {
      await builder.build();
      const found = takeProblems();
      if (found.length > 0) throw new ContentBuildError(found);
      return lastBuild;
    },
    sync: async (modification, filePath) => {
      if (!(await builder.sync(modification, filePath))) {
        const owner = ownerDocument(filePath, root);
        if (owner !== undefined) await builder.sync('update', owner);
      }
      return takeProblems();
    },
  };
}
