# Mock an HTTP API in a test

Goal: test code that calls an outside HTTP API, with no network.

1. Install the peer: `bun add -D msw`.
2. In the test file, call `setupMswServer()` at the top level and keep the server it returns.
3. In each test, add the answer with `server.use(http.get(url, () => HttpResponse.json(body)))`.
4. Call your code. It runs the real `fetch`. A request with no handler fails the test.
5. To check the URL your code built, capture `request.url` in the handler and assert it after the call.

The package's own test follows these steps: [src/msw.test.ts](../../src/msw.test.ts). Read the whole file before you copy it.

Run it:

```sh
bun run test -- src/msw.test.ts
```

Expected output ends with:

```text
 Test Files  1 passed (1)
      Tests  4 passed (4)
```
