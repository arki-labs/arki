/**
 * The typed client against the real engine, wired through `fetch` — no
 * sockets. The client must speak the server's wire format exactly: encode
 * what it sends, decode what it gets, and surface the server's error codes.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InvalidEnvelope, InvalidInput, isFailure, orThrow } from '@arki/failure';

import { routes } from '../bundle.js';
import { createClient } from '../client.js';
import { buildEngine } from '../compiled.js';
import { route } from '../contract.js';
import { HTTP_ERROR_CODES, HttpError } from '../error.js';
import { raw } from '../raw.js';
import { codec, optional } from '../wire.js';

const BASE = 'http://test.local';

const isoDate = codec(
  z.iso.datetime().transform(text => new Date(text)),
  z.date().transform(date => date.toISOString()),
);

const getEvent = route.get('/events/:id', {
  id: 'events.get',
  query: { since: optional(isoDate) },
  output: codec(
    z.object({ id: z.string(), at: isoDate.decode, since: isoDate.decode.nullable() }),
    z.object({ id: z.string(), at: isoDate.encode, since: isoDate.encode.nullable() }),
  ),
});

const moveEvent = route.post('/events/:id/move', {
  id: 'events.move',
  body: codec(z.object({ at: isoDate.decode }), z.object({ at: isoDate.encode })),
  output: codec(z.object({ id: z.string(), at: isoDate.decode }), z.object({ id: z.string(), at: isoDate.encode })),
});

const lockedEvent = route.delete('/events/:id', { id: 'events.delete', output: z.object({ ok: z.boolean() }) });

const rawEvent = route.get('/events/:id/raw', { id: 'events.raw', output: raw() });

const engine = buildEngine([
  routes()
    .bind(getEvent, ({ params, query }) => ({ id: params.id, at: new Date(0), since: query.since ?? null }))
    .bind(moveEvent, ({ params, body }) => ({ id: params.id, at: body.at }))
    .bind(lockedEvent, () => {
      throw new HttpError(403, HTTP_ERROR_CODES.forbidden, 'events are locked', { remediation: 'Ask an admin.' });
    })
    .bind(rawEvent, ({ params }) => new Response(`raw ${params.id}`)),
]);

/** Records every request so tests can check the wire form. */
function recordingFetch(handler: (req: Request) => Promise<Response>) {
  const sent: Request[] = [];
  const fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    sent.push(req.clone());
    return await handler(req);
  };
  return { fetch, sent };
}

describe('createClient', () => {
  it('round-trips a Date through the codec: ISO string on the wire, Date on both ends', async () => {
    const wire = recordingFetch(engine.fetch);
    const events = createClient({ getEvent, moveEvent }, { baseUrl: BASE, fetch: wire.fetch });

    const moved = await events.moveEvent({ params: { id: 'e1' }, body: { at: new Date(5000) } });
    if (isFailure(moved)) throw new Error(moved.code);
    expect(moved.at).toBeInstanceOf(Date);
    expect(moved).toEqual({ id: 'e1', at: new Date(5000) });
    expect(await wire.sent[0]?.json()).toEqual({ at: '1970-01-01T00:00:05.000Z' });
    expect(wire.sent[0]?.headers.get('content-type')).toBe('application/json');

    const fetched = await events.getEvent({ params: { id: 'e1' }, query: { since: new Date(1000) } });
    expect(fetched).toEqual({ id: 'e1', at: new Date(0), since: new Date(1000) });
    expect(wire.sent[1]?.url).toBe(`${BASE}/events/e1?since=1970-01-01T00%3A00%3A01.000Z`);
  });

  it('builds one call from a single contract and leaves optional input out', async () => {
    const wire = recordingFetch(engine.fetch);
    const fetchEvent = createClient(getEvent, { baseUrl: `${BASE}/`, fetch: wire.fetch });

    expect(await fetchEvent({ params: { id: 'a b/c' } })).toEqual({ id: 'a b/c', at: new Date(0), since: null });
    // Path params are escaped, and a trailing slash on baseUrl does not double up.
    expect(wire.sent[0]?.url).toBe(`${BASE}/events/a%20b%2Fc`);
  });

  it('classifies an undeclared server code as an invalid envelope', async () => {
    const remove = createClient(lockedEvent, { baseUrl: BASE, fetch: recordingFetch(engine.fetch).fetch });
    await expect(remove({ params: { id: 'e1' } })).resolves.toMatchObject({
      code: InvalidEnvelope.code,
      data: { reason: 'unknown_code' },
    });
  });

  it('refuses a path param that would change which endpoint is called, without sending it', async () => {
    // `..` in /events/:id/move resolves to /move: another endpoint, called with the user's cookies.
    const wire = recordingFetch(engine.fetch);
    const move = createClient(moveEvent, { baseUrl: BASE, fetch: wire.fetch });
    for (const id of ['..', '.', '']) {
      await expect(move({ params: { id }, body: { at: new Date(0) } })).resolves.toMatchObject({
        status: 400,
        code: InvalidInput.code,
        data: { issues: [{ message: expect.stringContaining('"id"') }] },
      });
    }
    expect(wire.sent).toHaveLength(0);
    // Dots inside a value are an ordinary id: only a whole "." or ".." segment moves the URL.
    orThrow(await move({ params: { id: '..e1' }, body: { at: new Date(0) } }));
    expect(wire.sent[0]?.url).toBe(`${BASE}/events/..e1/move`);
  });

  it('rejects a bad input with the 400 code the server would answer, without sending it', async () => {
    const wire = recordingFetch(engine.fetch);
    const move = createClient(moveEvent, { baseUrl: BASE, fetch: wire.fetch });
    // The type allows any Date, but an invalid Date has no ISO form.
    await expect(move({ params: { id: 'e1' }, body: { at: new Date('yesterday') } })).resolves.toMatchObject({
      status: 400,
      code: InvalidInput.code,
    });
    expect(wire.sent).toHaveLength(0);
  });

  it('maps a response without the error envelope to a code by status', async () => {
    const gateway = recordingFetch(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })));
    const notFound = recordingFetch(() => Promise.resolve(new Response('nope', { status: 404 })));

    await expect(
      createClient(getEvent, { baseUrl: BASE, fetch: gateway.fetch })({ params: { id: 'e1' } }),
    ).resolves.toMatchObject({ code: InvalidEnvelope.code, data: { reason: 'invalid_json' } });
    await expect(
      createClient(getEvent, { baseUrl: BASE, fetch: notFound.fetch })({ params: { id: 'e1' } }),
    ).resolves.toMatchObject({ code: InvalidEnvelope.code, data: { reason: 'invalid_json' } });
  });

  it('fails loudly when the response does not match the output schema', async () => {
    // Client and server on different contract versions: never hand back a wrong shape.
    const skewed = recordingFetch(() => Promise.resolve(Response.json({ id: 'e1', at: 'not a date', since: null })));
    await expect(
      createClient(getEvent, { baseUrl: BASE, fetch: skewed.fetch })({ params: { id: 'e1' } }),
    ).resolves.toMatchObject({ code: InvalidEnvelope.code, data: { reason: 'invalid_data' } });
  });

  it('hands back the raw Response when the contract declares output: raw()', async () => {
    const raw = createClient(rawEvent, { baseUrl: BASE, fetch: recordingFetch(engine.fetch).fetch });
    const res = await raw({ params: { id: 'e1' } });
    expect(res).toBeInstanceOf(Response);
    if (isFailure(res)) throw new Error(res.code);
    expect(await res.text()).toBe('raw e1');
  });
});
