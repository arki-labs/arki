import { createFileRoute } from '@tanstack/react-router';

import { serverApp } from '../../live.server';

async function handleRpc(request: Request): Promise<Response> {
  const app = await serverApp();
  const { matched, response } = await app.rpc.handle(request, { prefix: '/api/rpc' });
  return matched ? response : new Response('Not found', { status: 404 });
}

export const Route = createFileRoute('/api/rpc/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleRpc(request),
      POST: ({ request }) => handleRpc(request),
    },
  },
});
