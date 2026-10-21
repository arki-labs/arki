import { serve } from 'srvx'; import { h3App } from './h3-app.ts'; import { PORT, ready } from './shared.ts';
const server = serve({ port: PORT, hostname: '127.0.0.1', fetch: h3App().fetch }); await server.ready(); ready();
