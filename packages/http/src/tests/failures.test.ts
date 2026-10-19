/**
 * `@arki/failure` failures at the HTTP boundary, server and client. A failure
 * is an expected outcome the caller must handle, so it travels as a value end
 * to end: the handler returns it, the wire carries it in the one error
 * envelope, and the client resolves to it instead of throwing. The contract
 * lists the failures once, and both ends take their types from that list.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  AsyncSchema,
  defineFailure,
  InvalidEnvelope,
  isFailure,
  match,
  UnexpectedDefect,
  ValidatorDefect,
} from '@arki/failure';

import type { RouteFailure } from '../contract.js';
import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { route } from '../contract.js';
import { buildEngine } from '../engine.js';
import { HTTP_ERROR_CODES } from '../error.js';

const BASE = 'http://test.local';

const PostNotFound = defineFailure('post.not_found', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'no post {id}',
  remediation: 'Check the id.',
});
const PostLocked = defineFailure('post.locked', { status: 409 });
const PostUnlisted = defineFailure('post.unlisted', { status: 403 });

const Post = z.object({ id: z.string(), title: z.string() });
type Post = z.infer<typeof Post>;

const posts = new Map<string, Post>([['p1', { id: 'p1', title: 'Hello' }]]);
/** A usecase: the post, or a failure the caller must handle. */
const find = async (id: string) => {
  await Promise.resolve(); // stands in for the repository read
  if (id === 'locked') return PostLocked();
  return posts.get(id) ?? PostNotFound({ id });
};
/** A usecase that grew a failure the contract does not list yet. */
const findListed = async (id: string) => (id === 'unlisted' ? PostUnlisted() : find(id));

/** A fake server that answers every request with one error envelope. */
const answering = (status: number, error: Record<string, unknown>) => () =>
  Promise.resolve(Response.json({ error }, { status }));

const getPost = route.get('/posts/:id', { id: 'posts.get', output: Post, failures: [PostNotFound, PostLocked] });
/** Same failures, sync handler: the engine's no-await path. */
const peekPost = route.get('/posts/:id/peek', { id: 'posts.peek', output: Post, failures: [PostNotFound] });
const plainPost = route.get('/posts/:id/plain', { id: 'posts.plain', output: Post });

const engine = buildEngine([
  routes()
    .bind(getPost, ({ params }) => find(params.id))
    .bind(peekPost, ({ params }) => posts.get(params.id) ?? PostNotFound({ id: params.id }))
    .bind(plainPost, ({ params }) => posts.get(params.id) ?? { id: params.id, title: 'draft' }),
]);

const fetch = (input: string, init: RequestInit): Promise<Response> => engine.fetch(new Request(input, init));
const client = createClient({ getPost, peekPost, plainPost }, { baseUrl: BASE, fetch });

describe('a handler that returns a failure', () => {
  it('answers with the failure status and the one error envelope, so clients parse one format', async () => {
    for (const path of ['/posts/nope', '/posts/nope/peek']) {
      const res = await engine.fetch(new Request(`${BASE}${path}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: { code: 'post.not_found', message: 'no post nope', remediation: 'Check the id.', data: { id: 'nope' } },
      });
    }
    const locked = await engine.fetch(new Request(`${BASE}/posts/locked`));
    expect(locked.status).toBe(409);
    // No data, no remediation: the envelope leaves them out rather than sending nulls.
    expect(await locked.json()).toEqual({ error: { code: 'post.locked', message: 'post.locked' } });
  });

  it('never runs the output schema on a failure, which would turn an expected outcome into a 500', async () => {
    // The failure is not a Post; had it reached Post.encode, the answer would be ARKI_HTTP_E500.
    const res = await engine.fetch(new Request(`${BASE}/posts/nope`));
    expect(res.status).toBe(404);
    expect(await res.json()).not.toMatchObject({ error: { code: HTTP_ERROR_CODES.internal } });
  });

  it('makes a failure the contract does not list a compile error, so the client is never surprised', () => {
    const compileOnly = () =>
      routes()
        // @ts-expect-error -- 'post.unlisted' is not in getPost's failures
        .bind(getPost, ({ params }) => findListed(params.id))
        // @ts-expect-error -- a contract without failures accepts none
        .bind(plainPost, ({ params }) => find(params.id));
    expect(compileOnly).toBeTypeOf('function');
  });
});

describe('the client', () => {
  it('resolves to the revived failure, so frontend code matches on it like backend code', async () => {
    const result = await client.getPost({ params: { id: 'nope' } });
    expect(isFailure(result)).toBe(true);
    expect(PostNotFound.is(result)).toBe(true);
    expect(result).toMatchObject({
      code: 'post.not_found',
      status: 404,
      message: 'no post nope',
      data: { id: 'nope' },
    });
    const label = match(result, {
      ok: post => post.title,
      'post.not_found': failure => `missing ${failure.data.id}`,
      'post.locked': () => 'locked',
    });
    expect(label).toBe('missing nope');
    expect(PostLocked.is(await client.getPost({ params: { id: 'locked' } }))).toBe(true);
    expect(await client.getPost({ params: { id: 'p1' } })).toEqual({ id: 'p1', title: 'Hello' });
  });

  it('types the call as the output or one of the listed failures, written once on the contract', () => {
    type Listed = ReturnType<typeof PostNotFound> | ReturnType<typeof PostLocked>;
    expectTypeOf(client.getPost).returns.resolves.toEqualTypeOf<Post | Listed>();
    expectTypeOf<RouteFailure<typeof getPost>>().toEqualTypeOf<Listed>();
    // A contract without failures resolves to its output only.
    expectTypeOf(client.plainPost).returns.resolves.toEqualTypeOf<Post>();
    expectTypeOf<RouteFailure<typeof plainPost>>().toBeNever();
  });

  it('still throws HttpError for a failure the contract does not list, so unexpected errors stay loud', async () => {
    // A server on a newer contract version sends a failure this client does not know.
    const newer = createClient(getPost, {
      baseUrl: BASE,
      fetch: answering(403, { code: 'post.unlisted', message: 'x' }),
    });
    await expect(newer({ params: { id: 'p1' } })).rejects.toMatchObject({
      name: 'HttpError',
      status: 403,
      code: 'post.unlisted',
    });
  });

  it('refuses failure data its definition rejects, so client and server on different definitions fail loudly', async () => {
    const drifted = createClient(getPost, {
      baseUrl: BASE,
      fetch: answering(404, { code: 'post.not_found', message: 'x', data: { id: 42 } }),
    });
    await expect(drifted({ params: { id: 'x' } })).rejects.toMatchObject({
      name: 'HttpError',
      status: 500,
      code: HTTP_ERROR_CODES.internal,
    });
  });

  it('rejects async failure-data validation as a protocol defect rather than a listed domain failure', async () => {
    const AsyncFailure = defineFailure('post.async', { data: z.string().refine(() => Promise.resolve(true)) });
    const contract = route.get('/async-failure', { id: 'post.async', failures: [AsyncFailure] });
    const call = createClient(contract, {
      baseUrl: BASE,
      fetch: answering(400, { code: AsyncFailure.code, message: 'remote', data: 'x' }),
    });
    await expect(call()).rejects.toMatchObject({ name: 'HttpError', status: 500, cause: { code: AsyncSchema.code } });
  });

  it('rejects broken failure-message construction rather than leaking an undeclared defect as domain output', async () => {
    const BrokenMessage = defineFailure('post.broken_message', {
      message: () => {
        throw new Error('broken message');
      },
    });
    const contract = route.get('/broken-message', { id: 'post.broken_message', failures: [BrokenMessage] });
    const call = createClient(contract, {
      baseUrl: BASE,
      fetch: answering(400, { code: BrokenMessage.code, message: 'remote' }),
    });
    await expect(call()).rejects.toMatchObject({
      name: 'HttpError',
      status: 500,
      cause: { code: UnexpectedDefect.code },
    });
  });

  it('returns an explicitly declared canonical failure rather than confusing it with a decoder defect', async () => {
    const contract = route.get('/validator-defect', { id: 'post.validator_defect', failures: [ValidatorDefect] });
    const call = createClient(contract, {
      baseUrl: BASE,
      fetch: answering(500, { code: ValidatorDefect.code, message: 'remote' }),
    });
    expect(ValidatorDefect.is(await call())).toBe(true);
  });

  it('rejects invalid canonical failure data even when the same canonical definition is declared', async () => {
    const contract = route.get('/invalid-envelope', { id: 'post.invalid_envelope', failures: [InvalidEnvelope] });
    const call = createClient(contract, {
      baseUrl: BASE,
      fetch: answering(400, { code: InvalidEnvelope.code, message: 'remote', data: { reason: 'invented' } }),
    });
    await expect(call()).rejects.toMatchObject({
      name: 'HttpError',
      status: 500,
      cause: { code: InvalidEnvelope.code },
    });
  });
});
