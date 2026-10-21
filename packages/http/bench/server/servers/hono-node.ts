import { serve } from '@hono/node-server'; import { honoApp } from './hono-app.ts'; import { PORT, ready } from './shared.ts';
serve({ fetch: honoApp().fetch, port: PORT, hostname: '127.0.0.1' }, ready);
