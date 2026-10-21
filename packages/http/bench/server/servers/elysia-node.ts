import { node } from '@elysiajs/node'; import { elysiaApp } from './elysia-app.ts'; import { PORT, ready } from './shared.ts';
elysiaApp({ adapter: node() }).listen({ port: PORT, hostname: '127.0.0.1', reusePort: false }, info => {
  void (info as unknown as { raw: { ready(): Promise<unknown> } }).raw.ready().then(ready);
});
