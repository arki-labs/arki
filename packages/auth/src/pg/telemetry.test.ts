import { context, trace } from '@opentelemetry/api';
import { afterEach, expect, it, vi } from 'vitest';

import { observeAuth, observeSafely } from './telemetry.js';

afterEach(() => vi.restoreAllMocks());

it('preserves the exact successful response when the tracer throws', async () => {
  vi.spyOn(trace, 'getTracer').mockImplementation(() => {
    throw new Error('reporter fault');
  });
  const response = new Response(null, { status: 201 });
  const run = vi.fn(() => response);
  expect(await observeAuth('auth.handler', run)).toBe(response);
  expect(run).toHaveBeenCalledTimes(1);
});

it('preserves the exact business rejection when reporting fails', async () => {
  vi.spyOn(trace, 'getTracer').mockImplementation(() => {
    throw new Error('reporter fault');
  });
  const cause = new Error('business fault');
  await expect(observeAuth('auth.principal', () => Promise.reject(cause))).rejects.toBe(cause);
});

it('does not repeat authentication if the context manager reenters and throws', async () => {
  vi.spyOn(context, 'with').mockImplementation((_current, run) => {
    run();
    run();
    throw new Error('context manager fault');
  });
  const run = vi.fn(() => 'completed');
  expect(await observeAuth('auth.handler', run)).toBe('completed');
  expect(run).toHaveBeenCalledTimes(1);
});

it('records only status on an HTTP response and ends the default span', async () => {
  const tracer = trace.getTracer('@arki/auth');
  const span = tracer.startSpan('fixture');
  const attribute = vi.spyOn(span, 'setAttribute');
  const end = vi.spyOn(span, 'end');
  vi.spyOn(tracer, 'startSpan').mockReturnValue(span);
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  const response = new Response('private body', { status: 200, headers: { 'set-cookie': 'secret' } });
  expect(await observeAuth('auth.handler', () => response)).toBe(response);
  expect(attribute.mock.calls).toEqual([['http.response.status_code', 200]]);
  expect(end).toHaveBeenCalledOnce();
});


it('observes rejected reporters without awaiting or replacing completion', async () => {
  const cause = new Error('private reporter rejection');
  const rejection = Promise.reject(cause);
  const observed = vi.spyOn(rejection, 'then');
  expect(observeSafely(() => rejection)).toBe(rejection);
  expect(observed).toHaveBeenCalled();
  const response = new Response(null, { status: 204 });
  expect(await observeAuth('auth.handler', () => response)).toBe(response);
});
