import { expect, expectTypeOf, it } from 'vitest';

import { buildSync } from 'esbuild';

import type { RuntimeEvent, RuntimeUiState, useRuntimeStream } from './index';

/** React is the caller's peer; the check is about what this entry pulls in, not React itself. */
const PEERS = ['react', 'react-dom', 'react/jsx-runtime'];

/** Bundles the react entry the way a browser app does; returns its inputs and exported names. */
function bundleReactEntry(): { inputs: string[]; exports: string[] } {
  const result = buildSync({
    entryPoints: [new URL('index.ts', import.meta.url).pathname],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outdir: 'browser-entry-check',
    write: false,
    metafile: true,
    logLevel: 'silent',
    external: PEERS,
  });
  const outputs = Object.values(result.metafile.outputs);
  return { inputs: Object.keys(result.metafile.inputs), exports: outputs.flatMap(output => output.exports) };
}

// A browser app renders runtime events with the reducer behind `useRuntimeStream`. When only the root entry
// offered it, CanIBrandIt's comparison War Room imported `@arki/ai` in the browser and crashed: the root also
// re-exports the Qdrant provider, which reads `createHash` from `node:crypto`.
it('the react entry bundles for the browser and offers the runtime UI reducer without the vector-search providers', () => {
  const bundle = bundleReactEntry();
  expect(bundle.exports).toEqual(expect.arrayContaining(['runtimeEventReducer', 'initialRuntimeUiState']));
  expect(bundle.inputs.filter(input => input.includes('vector-search/'))).toEqual([]);
});

it('the react entry names the types its runtime hook speaks', () => {
  expectTypeOf<ReturnType<typeof useRuntimeStream>['state']>().toEqualTypeOf<RuntimeUiState>();
  expectTypeOf<Parameters<ReturnType<typeof useRuntimeStream>['run']>[0]>().toEqualTypeOf<
    (signal: AbortSignal) => AsyncIterable<RuntimeEvent>
  >();
});
