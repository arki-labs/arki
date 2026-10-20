/**
 * Slice 0 probe: the SDK v2 facts every later slice rests on. Replaced by
 * `handler.test.ts` in slice 1. If the SDK's handler shape changes, these
 * break first, before any `@arki/mcp` code hides the cause.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const MCP_URL = new URL('http://probe.local/mcp');

/** One server, one tool. A fresh `McpServer` per request is what lets slice 1 bind the principal per call. */
function probeHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    server.registerTool(
      'hello_greet',
      {
        description: 'Greet someone by name.',
        inputSchema: z.object({ name: z.string() }),
        outputSchema: z.object({ greeting: z.string() }),
      },
      ({ name }) => {
        const output = { greeting: `Hello, ${name}` };
        return { content: [{ type: 'text', text: output.greeting }], structuredContent: output };
      },
    );
    return server;
  });
}

/** The official client wired straight into `handler.fetch`: no socket, no port — the path a Worker or Bun `export default { fetch }` takes. */
async function connect(handler: ReturnType<typeof probeHandler>, pin?: string) {
  const client = new Client(
    { name: 'probe-client', version: '0.0.0' },
    pin === undefined ? {} : { versionNegotiation: { mode: { pin } } },
  );
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  await client.connect(transport);
  return client;
}

describe('createMcpHandler (SDK v2)', () => {
  it('handler answers tools/list and tools/call over the 2026-07-28 protocol', async () => {
    const client = await connect(probeHandler(), '2026-07-28');
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');

    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name)).toEqual(['hello_greet']);

    const result = await client.callTool({ name: 'hello_greet', arguments: { name: 'Ada' } });
    expect(result.structuredContent).toEqual({ greeting: 'Hello, Ada' });
    await client.close();
  });

  it('handler negotiates protocol 2025-11-25, so older Claude Desktop builds still connect', async () => {
    const client = await connect(probeHandler());
    expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');

    const result = await client.callTool({ name: 'hello_greet', arguments: { name: 'Ada' } });
    expect(result.structuredContent).toEqual({ greeting: 'Hello, Ada' });
    await client.close();
  });

  it('handler serves a plain Request and returns a plain Response, the edge shape with no node: import on the path', async () => {
    const response = await probeHandler().fetch(
      new Request(MCP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'raw', version: '0.0.0' },
          },
        }),
      }),
    );
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('"protocolVersion":"2025-11-25"');
    expect(body).toContain('"name":"probe"');
  });
});
