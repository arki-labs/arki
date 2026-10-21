import { serve } from 'srvx'; import { rawFetch } from './raw-fetch.ts'; import { PORT, ready } from './shared.ts';
const server = serve({ port: PORT, hostname: '127.0.0.1', fetch: rawFetch }); await server.ready(); ready();
