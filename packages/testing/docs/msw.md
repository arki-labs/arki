# HTTP mocking with MSW

`@arki/testing/msw` wraps [MSW](https://mswjs.io) for Vitest. Your code calls the real `fetch` with the real URL, and MSW answers at the network layer. Needs the `msw` peer.

## Why MSW and not `vi.stubGlobal('fetch')`

- The code under test runs `encodeURIComponent`, header building and query building for real.
- An unmatched request fails the test (`onUnhandledRequest: 'error'` is the default). A URL bug, such as an unencoded slug, shows up as a failure and not as a silent hit on another stub.
- Handlers are declarations ("for this URL, answer this") and not a global you re-stub in each test.

## Set up once per app

`setupMswServer()` registers `beforeAll(listen)`, `afterEach(resetHandlers)` and `afterAll(close)` and returns the server. Put it in a Vitest setup file, or at the top of one test file.

```ts skip="registers Vitest hooks, so it must run inside Vitest"
import { setupMswServer } from '@arki/testing/msw';

export const server = setupMswServer();
```

Pass `{ onUnhandledRequest: 'warn' | 'bypass' }` to relax the policy while you migrate. Do not leave it relaxed: find out why the test makes an unmocked request.

## Use it in a test

```ts skip="registers Vitest hooks, so it must run inside Vitest"
import { describe, expect, it } from 'vitest';

import { http, HttpResponse, setupMswServer } from '@arki/testing/msw';

const server = setupMswServer();
const JOBS_URL = 'https://boards.example.test/v1/boards/:slug/jobs';

describe('fetchJobs', () => {
  it('maps a posting', async () => {
    server.use(http.get(JOBS_URL, () => HttpResponse.json({ jobs: [{ id: 1 }] })));
    expect(await fetchJobs('acme')).toBe(1);
  });

  it('throws on 503', async () => {
    server.use(http.get(JOBS_URL, () => new HttpResponse(null, { status: 503 })));
    await expect(fetchJobs('acme')).rejects.toThrow(/503/);
  });
});
```

The entry re-exports `http`, `HttpResponse`, `passthrough`, `delay` and the common types, so tests need no direct `msw` import. The working version of this test is [src/msw.test.ts](../src/msw.test.ts) in the package source.

## Patterns

- Add handlers with `server.use(...)` inside the test. They reset after each test.
- To assert what the code sent, capture `request.url` or `await request.json()` in the handler and assert after the call.
- For a response with no JSON, use `new HttpResponse(null, { status })` or `new HttpResponse(text, { status, headers })`.
