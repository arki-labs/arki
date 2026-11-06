import { serve } from 'srvx'; import { h3App } from './h3-app.ts'; import { PORT, ready } from './shared.ts';
const app = h3App(); const server = serve({ port: PORT, hostname: '127.0.0.1', fetch: request => app.fetch(request) }); await server.ready(); ready();
