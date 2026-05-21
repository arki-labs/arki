import { createFileRoute } from '@tanstack/react-router';
import { RPCHandler } from '@orpc/server/fetch';
import { appRouter, createRPCContext } from '@arki/backend/api';

import { auth } from '~/features/auth/auth.server';

const setCorsHeaders = (res: Response) => {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Request-Method', '*');
  res.headers.set('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
  res.headers.set('Access-Control-Allow-Headers', '*');
};

const handler = new RPCHandler(appRouter);

async function handleRequest(request: Request) {
  const context = await createRPCContext({
    auth,
    headers: request.headers,
  });

  const { matched, response } = await handler.handle(request, {
    prefix: '/api/orpc',
    context,
  });

  if (matched) {
    setCorsHeaders(response);
    return response;
  }

  return new Response('Not found', { status: 404 });
}

export const Route = createFileRoute('/api/orpc/$')({
  server: {
    handlers: {
      GET: ({ request }: { request: Request }) => handleRequest(request),
      POST: ({ request }: { request: Request }) => handleRequest(request),
      PUT: ({ request }: { request: Request }) => handleRequest(request),
      PATCH: ({ request }: { request: Request }) => handleRequest(request),
      DELETE: ({ request }: { request: Request }) => handleRequest(request),
      OPTIONS: () => {
        const response = new Response(null, { status: 204 });
        setCorsHeaders(response);
        return response;
      },
    },
  },
});
