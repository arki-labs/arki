import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';

import { serialize } from '@arki/failure';

import type { RuntimeEvent, RuntimeFailure } from '../../runtime/types';
import type { GenerationResult, UseAIGenerationReturn , generationResultSchema} from './useAIGeneration';
import type { SearchResult , searchResultSchema} from './useSemanticSearch';
import { RateLimited } from '../../failures';
import { RUNTIME_FAILURES } from '../../runtime/types';
import { useAIGeneration } from './useAIGeneration';
import { useRuntimeStream } from './useRuntimeStream';
import { useSemanticSearch } from './useSemanticSearch';

/**
 * The hooks run outside a renderer: React is replaced at its boundary by a store that keeps each
 * `useState` slot by call order, so a test reads what the hook last set. The hook logic itself is real.
 */
const react = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = react.cursor;
    react.cursor += 1;
    if (!(index in react.slots)) react.slots[index] = initial;
    return [react.slots[index], (next: unknown) => (react.slots[index] = next)];
  },
  useCallback: (callback: unknown) => callback,
  useRef: (initial: unknown) => ({ current: initial }),
  useEffect: () => {
    // Effects do not run in this hook harness.
  },
}));

beforeEach(() => {
  react.slots = [];
  react.cursor = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Lets pending promises and zero-delay timers run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

function failureResponse(failure: RuntimeFailure, status: number): Response {
  return Response.json({ error: serialize(failure, RUNTIME_FAILURES) }, { status });
}

describe('useAIGeneration', () => {
  // useState order in the hook: isGenerating, result, error.
  const ERROR_SLOT = 2;

  it('returns the typed failure the server answered with, instead of an HTTP status error', async () => {
    // WHY (F14): a 429 used to become Error('HTTP error! status: 429'); the caller needs RateLimited
    // and its wait to back off.
    vi.stubGlobal('fetch', () => Promise.resolve(failureResponse(RateLimited({ retryAfterMs: 700 }), 429)));
    const heard: RuntimeFailure[] = [];
    const hook = useAIGeneration({ onError: failure => heard.push(failure) });
    const outcome = await hook.generate('hi');
    expect(RateLimited.is(outcome) ? outcome.data.retryAfterMs : undefined).toBe(700);
    expect(heard.map(failure => failure.code)).toEqual(['ai.rate_limited']);
    expect(react.slots[ERROR_SLOT]).toBe(outcome);
  });

  it('reports a non-OK body that is not a failure as InvalidEnvelope', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('<html>oops</html>', { status: 500 })));
    const outcome = await useAIGeneration().generate('hi');
    expect('code' in outcome ? outcome.code : undefined).toBe('failure.invalid_envelope');
  });

  it('checks the response with a schema instead of casting it', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ content: 42, type: 'text' })));
    const outcome = await useAIGeneration().generate('hi');
    expect('code' in outcome ? outcome.code : undefined).toBe('schema.invalid_input');
  });

  it('keeps a character split across two stream chunks whole', async () => {
    // WHY (F14): decoding each chunk alone turned a split "é" into two replacement characters.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xC3]));
        controller.enqueue(new Uint8Array([0xA9]));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(body)));
    const outcome = await useAIGeneration().generate('hi', { type: 'stream' });
    expect('content' in outcome ? outcome.content : undefined).toBe('café');
  });

  it('reports a request that never connected as ConnectionLost', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
    const outcome = await useAIGeneration().generate('hi');
    expect('code' in outcome ? outcome.code : undefined).toBe('ai.connection_lost');
  });

  it('types generate without null and locks the response schema to GenerationResult both ways', () => {
    expectTypeOf<ReturnType<UseAIGenerationReturn['generate']>>().toEqualTypeOf<
      Promise<GenerationResult | RuntimeFailure>
    >();
    expectTypeOf<z.output<typeof generationResultSchema>>().toEqualTypeOf<GenerationResult>();
  });
});

describe('useSemanticSearch', () => {
  // useState order in the hook: query, results, suggestions, isSearching, error.
  const RESULTS_SLOT = 1;
  const SEARCHING_SLOT = 3;
  const ERROR_SLOT = 4;

  it('keeps isSearching on for the newer search when an older one is aborted', async () => {
    // WHY (F14): the aborted request's cleanup used to clear isSearching while the newer request was
    // still running, so the spinner vanished early.
    let release: (response: Response) => void = () => {
      // Replaced by the first request's resolver.
    };
    const fetchStub = vi.fn((_url: string, init: RequestInit) => {
      if (fetchStub.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }
      return new Promise<Response>(resolve => (release = resolve));
    });
    vi.stubGlobal('fetch', fetchStub);
    const hook = useSemanticSearch({ debounceMs: 0 });

    await hook.search('first');
    await settle();
    await hook.search('second');
    await settle();
    expect(react.slots[SEARCHING_SLOT]).toBe(true);

    release(Response.json({ results: [{ id: 'a', score: 0.9 }] }));
    await settle();
    expect(react.slots[SEARCHING_SLOT]).toBe(false);
    expect(react.slots[RESULTS_SLOT]).toEqual([{ id: 'a', score: 0.9 }]);
  });

  it('checks the results with a schema and reports a bad body as InvalidInput', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ results: [{ id: 1 }] })));
    const hook = useSemanticSearch({ debounceMs: 0 });
    await hook.search('query');
    await settle();
    expect(react.slots[ERROR_SLOT]).toMatchObject({ code: 'schema.invalid_input' });
    expect(react.slots[SEARCHING_SLOT]).toBe(false);
  });

  it('locks the result schema to SearchResult both ways', () => {
    expectTypeOf<z.output<typeof searchResultSchema>>().toEqualTypeOf<SearchResult>();
  });
});

describe('useRuntimeStream', () => {
  // useState order in the hook: state.
  const STATE_SLOT = 0;

  it('stop() aborts the signal the source got and ends the run Cancelled, not running', async () => {
    // WHY (F14): stop() aborted a controller the source never saw, so the request ran on and the
    // state stayed `running`.
    let seen: AbortSignal | undefined;
    async function* source(signal: AbortSignal): AsyncIterable<RuntimeEvent> {
      seen = signal;
      yield { type: 'run:start' };
      await new Promise(resolve => signal.addEventListener('abort', resolve));
    }
    const hook = useRuntimeStream();
    const done = hook.run(source);
    await settle();
    hook.stop();
    await done;
    expect(seen?.aborted).toBe(true);
    expect(react.slots[STATE_SLOT]).toMatchObject({ status: 'error', failure: { code: 'ai.cancelled' } });
  });

  it('ends a source that stops without run:finish or run:error as ConnectionLost', async () => {
    async function* source(): AsyncIterable<RuntimeEvent> {
      yield { type: 'run:start' };
      yield { type: 'text:delta', delta: 'hel' };
    }
    await useRuntimeStream().run(source);
    expect(react.slots[STATE_SLOT]).toMatchObject({
      status: 'error',
      text: 'hel',
      failure: { code: 'ai.connection_lost' },
    });
  });
});
