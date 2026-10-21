import { honoApp } from './hono-app.ts'; import { PORT, ready } from './shared.ts';
Bun.serve({ port: PORT, fetch: honoApp().fetch }); ready();
