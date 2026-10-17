import { describe, expect, it } from 'vitest';

import { httpFixtures } from './http-fixtures.js';

describe('http-fixtures', () => {
  it('answers real requests from the handler and frees the port after stop, even when stopped twice', async () => {
    const spec = httpFixtures({
      handle: request => new Response(`hello ${new URL(request.url).searchParams.get('who')}`, { status: 201 }),
    });
    const started = await spec.start({ runId: 'http-fixtures-test' });
    const answer = await fetch(`${started.value.url}/page?who=feed`);
    expect(answer.status).toBe(201);
    expect(await answer.text()).toBe('hello feed');

    await started.stop();
    await started.stop();
    await expect(fetch(started.value.url)).rejects.toThrow();
  });

  it('answers 500 with the reason when the handler throws', async () => {
    const started = await httpFixtures({
      handle: () => {
        throw new Error('boom');
      },
    }).start({ runId: 'http-fixtures-test' });
    try {
      const answer = await fetch(started.value.url);
      expect(answer.status).toBe(500);
      expect(await answer.text()).toContain('boom');
    } finally {
      await started.stop();
    }
  });
});
