// Cross-runtime smoke test. Runs under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes targets.
// Slice 0: the root entry exports types only, so the checks drive the SDK's
// `createMcpHandler` directly with a plain Request — the edge shape every later
// slice relies on. Slice 1 swaps these for `defineMcp`.

import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import '../dist/index.js';

const MCP_URL = 'http://smoke.local/mcp';

const handler = createMcpHandler(() => {
  const server = new McpServer({ name: 'smoke', version: '0.0.0' });
  server.registerTool(
    'hello_greet',
    { description: 'Greet someone by name.', inputSchema: z.object({ name: z.string() }) },
    ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}` }] }),
  );
  return server;
});

/** One JSON-RPC call as a plain POST; the answer is JSON or one SSE `data:` frame. */
async function call(id, method, params) {
  const response = await handler.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }),
  );
  const text = await response.text();
  const frame = text.split('\n').find(line => line.startsWith('data: '));
  return { status: response.status, body: JSON.parse(frame === undefined ? text : frame.slice('data: '.length)) };
}

async function main() {
  const init = await call(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '0.0.0' },
  });
  const listed = await call(2, 'tools/list', {});
  const called = await call(3, 'tools/call', { name: 'hello_greet', arguments: { name: 'Ada' } });

  const checks = [
    ['initialize answers 200', init.status, 200],
    ['initialize negotiates 2025-11-25', init.body.result?.protocolVersion, '2025-11-25'],
    ['tools/list names the tool', listed.body.result?.tools?.map(tool => tool.name).join(','), 'hello_greet'],
    ['tools/call runs the tool', called.body.result?.content?.[0]?.text, 'Hello, Ada'],
  ];

  let failedChecks = 0;
  for (const [name, actual, expected] of checks) {
    if (actual === expected) continue;
    failedChecks++;
    console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  const runtime =
    typeof HermesInternal !== 'undefined'
      ? 'hermes'
      : typeof Deno !== 'undefined'
        ? 'deno'
        : typeof Bun !== 'undefined'
          ? 'bun'
          : typeof window !== 'undefined'
            ? 'browser'
            : 'node';
  if (failedChecks > 0) {
    console.log(`${runtime}: ${failedChecks} smoke checks FAILED`);
    throw new Error('smoke failed');
  }
  console.log(`${runtime}: ${checks.length} smoke checks passed`);
}

await main();
