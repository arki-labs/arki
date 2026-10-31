/**
 * The judge and the embedder against a small real HTTP server that speaks Ollama's three routes.
 * The failures matter because a scorer reads them as `unscorable`, never as a pass or a zero.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import type { Score } from './score.js';
import { createEmbedder, createJudge, digestOf, OllamaAnswerInvalid, OllamaUnavailable } from './judge.js';
import { rubric, similarTo } from './scorers.js';

type Route = (path: string) => { readonly status?: number; readonly body: string; readonly delayMs?: number };

const servers: Server[] = [];

async function ollamaAt(route: Route): Promise<string> {
  const server = createServer((request, response) => {
    const answer = route(request.url ?? '');
    setTimeout(() => {
      response.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      response.end(answer.body);
    }, answer.delayMs ?? 0);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the test server has no port');
  return `http://127.0.0.1:${address.port}`;
}

const tags = JSON.stringify({ models: [{ name: 'judge:1b', digest: 'abc' }] });
const chat = (content: string) => JSON.stringify({ message: { content } });

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

const sample = { output: 'text', input: undefined, expected: undefined };

describe('digestOf', () => {
  it('says OLLAMA_NOT_RUNNING instead of a bare "fetch failed" when nothing listens', async () => {
    await expect(digestOf('http://127.0.0.1:1', 'judge:1b')).rejects.toThrow(/OLLAMA_NOT_RUNNING/);
  });

  it('says OLLAMA_NOT_RUNNING for an answer that is not a tags list, and finds a listed model', async () => {
    const odd = await ollamaAt(() => ({ body: '"nope"' }));
    await expect(digestOf(odd, 'judge:1b')).rejects.toThrow(/OLLAMA_NOT_RUNNING/);
    const real = await ollamaAt(() => ({ body: tags }));
    expect(await digestOf(real, 'judge:1b')).toBe('abc');
    expect(await digestOf(real, 'other')).toBeUndefined();
  });
});

describe('judge answers', () => {
  it('returns the verdict when the answer is good', async () => {
    const url = await ollamaAt(path => ({ body: path === '/api/tags' ? tags : chat('{"pass":true,"reason":"ok"}') }));
    const judge = await createJudge({ url, model: 'judge:1b' });
    expect(await judge.verdict({ rubric: 'r', output: 'o' })).toEqual({ pass: true, reason: 'ok' });
  });

  it.each([
    ['an error status', { status: 500, body: 'boom' }, OllamaUnavailable],
    ['text that is not JSON', { body: chat('sorry, I cannot') }, OllamaAnswerInvalid],
    ['JSON of the wrong shape', { body: chat('{"pass":"yes"}') }, OllamaAnswerInvalid],
    ['a body without a message', { body: '{}' }, OllamaAnswerInvalid],
  ])('returns a typed failure for %s', async (_name, answer, failure) => {
    const url = await ollamaAt(path => (path === '/api/tags' ? { body: tags } : answer));
    const judge = await createJudge({ url, model: 'judge:1b' });
    expect(failure.is(await judge.verdict({ rubric: 'r', output: 'o' }))).toBe(true);
  });

  it('returns OllamaUnavailable when a call is slower than timeoutMs', async () => {
    const url = await ollamaAt(path => (path === '/api/tags' ? { body: tags } : { body: chat('{}'), delayMs: 400 }));
    const judge = await createJudge({ url, model: 'judge:1b', timeoutMs: 50 });
    expect(OllamaUnavailable.is(await judge.verdict({ rubric: 'r', output: 'o' }))).toBe(true);
  });

  it('turns a judge failure into an unscorable score, not a throw or a zero', async () => {
    const url = await ollamaAt(path => (path === '/api/tags' ? { body: tags } : { status: 500, body: 'boom' }));
    const judge = await createJudge({ url, model: 'judge:1b' });
    const score: Score = await rubric('polite').score(sample, { judge });
    expect(score.status).toBe('unscorable');
  });
});

describe('embedder answers', () => {
  it('returns one vector per text', async () => {
    const url = await ollamaAt(path => ({ body: path === '/api/tags' ? tags : '{"embeddings":[[1,0],[0,1]]}' }));
    const embedder = await createEmbedder({ url, model: 'judge:1b' });
    expect(await embedder.embed(['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
  });

  it.each([
    ['a wrong count', '{"embeddings":[[1,0]]}'],
    ['vectors that are not numbers', '{"embeddings":[["x"]]}'],
    ['no embeddings key', '{}'],
  ])('returns OllamaAnswerInvalid for %s, and similarTo is unscorable', async (_name, body) => {
    const url = await ollamaAt(path => ({ body: path === '/api/tags' ? tags : body }));
    const embedder = await createEmbedder({ url, model: 'judge:1b' });
    expect(OllamaAnswerInvalid.is(await embedder.embed(['a', 'b']))).toBe(true);
    const score = await similarTo('ref', { atLeast: 0.5 }).score(sample, { embedder });
    expect(score.status).toBe('unscorable');
  });
});
