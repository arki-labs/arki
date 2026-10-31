import { describe, expect, it } from 'vitest';

import { defineFailure } from '@arki/failure';

import { createORPCHandler } from './server';

const Refused = defineFailure('test.refused', { status: 401, message: 'Sign in to continue.' });
const rpcRequest = () => new Request('http://localhost/api/orpc/ping', { method: 'POST' });

describe('createORPCHandler() on a createContext that throws', () => {
  it('answers a thrown failure with its own status and code', async () => {
    const { handleRequest } = createORPCHandler({
      router: {},
      createContext: () => {
        // A failure is a value, not an Error: a lookup that throws one is still answered by its status.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw Refused();
      },
    });
    const response = await handleRequest(rpcRequest());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: 'test.refused', message: 'Sign in to continue.' } });
  });

  it('masks any other throw as a typed 500 that keeps the cause off the wire', async () => {
    const { handleRequest } = createORPCHandler({
      router: {},
      createContext: () => {
        throw new Error('session store at redis://:hunter2@kv is down');
      },
    });
    const response = await handleRequest(rpcRequest());
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({ error: { code: 'tanstack_start.internal', message: 'Internal Server Error' } });
  });
});
