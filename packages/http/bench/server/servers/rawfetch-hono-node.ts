import { serve } from '@hono/node-server'; import { rawFetch } from './raw-fetch.ts'; import { PORT, ready } from './shared.ts';
serve({ fetch: rawFetch, port: PORT, hostname: '127.0.0.1' }, ready);
