import { serve } from 'srvx'; import { honoApp } from './hono-app.ts'; import { PORT, ready } from './shared.ts';
const server = serve({ port: PORT, hostname: '127.0.0.1', fetch: honoApp().fetch }); await server.ready(); ready();
