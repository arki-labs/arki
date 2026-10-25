import { isBuiltin } from 'node:module';
import { buildSync } from 'esbuild';
import { expect, it } from 'vitest';

/** Every Node built-in (`node:crypto`, `child_process`, ...) a file reached from `entry` imports, as `file -> module`. */
function nodeBuiltinsReachedFrom(entry: string): string[] {
  const result = buildSync({
    entryPoints: [new URL(entry, import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    // Dependencies are the caller's install; the check is about this package's own files.
    packages: 'external',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  // `packages: 'external'` also marks `node:*` external, so the build succeeds either way: read the metafile.
  return Object.entries(result.metafile.inputs).flatMap(([file, input]) =>
    input.imports.filter(imported => isBuiltin(imported.path)).map(imported => `${file} -> ${imported.path}`),
  );
}

// The root entry promises Node, Bun, Deno, browsers and Hermes. It once re-exported the Qdrant provider
// (`node:crypto`) and the PodHop capability (`node:child_process`), so a browser app importing `@arki/ai`
// crashed. Node-only code lives behind its own entry (`./capabilities/podhop`).
it('the root entry reaches no Node built-in', () => {
  expect(nodeBuiltinsReachedFrom('index.ts')).toEqual([]);
});
