import Fastify from 'fastify';
import { createItem, NOT_FOUND, ping, PORT, ready, user } from './shared.ts';
const app = Fastify({ logger: false });
app.get('/ping', async () => ping());
app.get<{ Params: { id: string } }>('/users/:id', async req => user(req.params.id));
app.post('/items', async (req, reply) => { const r = createItem(req.body); reply.code(r.status); return r.body; });
app.setNotFoundHandler(async (_req, reply) => { reply.code(404); return NOT_FOUND.body; });
await app.listen({ port: PORT, host: '127.0.0.1' });
ready();
