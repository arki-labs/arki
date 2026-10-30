import type { ContractRouterClient } from '@orpc/contract';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createORPCClient, ORPCError } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { oc } from '@orpc/contract';
import { createRouterClient, implement } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { defineFailure, isFailure } from '@arki/failure';
import { errorMap, orThrowRpc } from '@arki/failure/orpc';

import type { ToolCall } from './tool.js';
import { asTool } from './contract.js';
import { fromRpc } from './orpc.js';
import { toolResult } from './result.js';

const Missing = defineFailure('catalog.missing', {
  status: 404,
  data: z.object({ id: z.string() }),
  message: 'No item has this id.',
  remediation: 'List item ids first.',
});
const lookup = asTool(
  oc
    .input(z.object({ id: z.string() }))
    .output(z.object({ name: z.string() }))
    .errors(errorMap(Missing)),
  {
    description: 'Find an item by id.',
    access: 'public',
    effect: 'read',
  },
);
const contract = { lookup, privateLookup: oc.input(z.string()).output(z.string()) };
const call: ToolCall = { principal: null, signal: new AbortController().signal, budget: { maxChars: 8000 } };

describe('fromRpc', () => {
  it('exposes only wrapped leaves and preserves gateway and procedure middleware', async () => {
    const seen: string[] = [];
    const root = implement(contract)
      .$context<{ owner: string }>()
      .use(async ({ next }) => {
        seen.push('root');
        return next();
      });
    const router = root.router({
      lookup: root.lookup
        .use(async ({ next }) => {
          seen.push('procedure');
          return next();
        })
        .handler(({ input, context, errors }) => {
          seen.push(context.owner);
          return orThrowRpc(input.id === 'missing' ? Missing({ id: input.id }) : { name: input.id }, errors);
        }),
      privateLookup: root.privateLookup.handler(({ input }) => input),
    });
    const client = createRouterClient(router, { context: { owner: 'catalog' } });
    const tools = fromRpc(
      { feature: 'catalog', contract, router },
      {
        client: () => client,
      },
    );
    expect(Object.keys(tools)).toEqual(['catalog_lookup']);
    expectTypeOf<
      Extract<Awaited<ReturnType<typeof tools.catalog_lookup.run>>, { code: 'catalog.missing' }>
    >().toEqualTypeOf<ReturnType<typeof Missing>>();
    // @ts-expect-error Procedures without explicit exposure are absent from the tool registry.
    void tools.catalog_private_lookup;
    const incompatibleClient = {
      lookup: () => Promise.resolve(1),
      privateLookup: (input: string) => Promise.resolve(input),
    };
    fromRpc(
      { feature: 'catalog', contract, router },
      {
        // @ts-expect-error The native gateway capability must match the contract output.
        client: () => incompatibleClient,
      },
    );
    const result = await tools.catalog_lookup.run({ id: 'book' }, call);
    expect(result).toEqual({ name: 'book' });
    expect(seen).toEqual(['root', 'procedure', 'catalog']);
    const missing = await tools.catalog_lookup.run({ id: 'missing' }, call);
    expect(isFailure(missing)).toBe(true);
    if (Missing.is(missing)) expectTypeOf(missing.data).toEqualTypeOf<{ id: string }>();
    expect(missing).toMatchObject({ code: 'catalog.missing', data: { id: 'missing' } });
    expect(await tools.catalog_lookup.invoke({ id: 'missing' }, call)).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'catalog.missing: No item has this id. List item ids first.' }],
    });
    expect(await tools.catalog_lookup.invoke({ id: 'book' }, call)).toMatchObject({
      structuredContent: { name: 'book' },
    });
  });

  it('denies access and unapproved destructive calls before reaching the gateway', async () => {
    let executions = 0;
    const tools = fromRpc(
      {
        feature: 'catalog',
        router: {},
        contract: {
          admin: asTool(oc, { description: 'Read private inventory.', access: { roles: ['admin'] }, effect: 'read' }),
          remove: asTool(oc, {
            description: 'Remove an item.',
            access: 'public',
            effect: 'destructive',
            confirm: 'elicit',
          }),
          hidden: asTool(oc, { description: 'Hidden inventory.', access: 'public', effect: 'read', hidden: true }),
        },
      },
      {
        client: () => ({
          admin: () => {
            executions++;
            return Promise.resolve({});
          },
          remove: () => {
            executions++;
            return Promise.resolve({});
          },
          hidden: () => Promise.resolve({}),
        }),
      },
    );
    expect(Object.keys(tools)).toEqual(['catalog_admin', 'catalog_remove']);
    expect(await tools.catalog_admin.invoke(undefined, call)).toMatchObject({ isError: true });
    expect(await tools.catalog_remove.invoke(undefined, call)).toMatchObject({ isError: true });
    expect(executions).toBe(0);
    await tools.catalog_remove.invoke(undefined, { ...call, approve: () => true });
    expect(executions).toBe(1);
  });

  it('scrubs middleware denials and unexpected exceptions into protocol errors', async () => {
    const tools = fromRpc(
      { feature: 'catalog', contract, router: {} },
      {
        client: () => ({
          lookup: () => Promise.reject(new ORPCError('FORBIDDEN', { message: 'private secret' })),
          privateLookup: input => Promise.resolve(input),
        }),
      },
    );
    const result = await tools.catalog_lookup.invoke({ id: 'book' }, call);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('mcp.forbidden');
    expect(JSON.stringify(result)).not.toContain('private secret');
  });

  it('preserves native output transforms once and serves native MCP envelopes through the SDK', async () => {
    let transforms = 0;
    let inputTransforms = 0;
    const transformed = asTool(
      oc
        .input(
          z.string().transform(value => {
            inputTransforms++;
            return value.length;
          }),
        )
        .output(
          z.number().transform(value => {
            transforms++;
            return String(value);
          }),
        ),
      { description: 'Count letters in a name.', access: 'public', effect: 'read' },
    );
    const transformedContract = { count: transformed };
    const root = implement(transformedContract);
    const router = root.router({ count: root.count.handler(({ input }) => input) });
    const native = createRouterClient(router);
    const tools = fromRpc({ feature: 'catalog', contract: transformedContract, router }, { client: () => native });
    expect(await tools.catalog_count.run('book', call)).toBe('4');
    expect(inputTransforms).toBe(1);
    expect(transforms).toBe(1);

    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'catalog', version: '0.0.0' });
      server.registerTool(
        'catalog_count',
        { description: 'Count letters in a name.', inputSchema: z.object({ name: z.string() }) },
        ({ name }) => tools.catalog_count.invoke(name, call),
      );
      return server;
    });
    const client = new Client({ name: 'fixture', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://fixture.local/mcp'), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      }),
    );
    try {
      expect(await client.callTool({ name: 'catalog_count', arguments: { name: 'book' } })).toMatchObject({
        content: [{ type: 'text', text: '"4"' }],
      });
      expect(transforms).toBe(2);
      expect(inputTransforms).toBe(2);
    } finally {
      await client.close();
    }
  });

  it('rejects colliding tool names and excludes child mounts', () => {
    const nested = { first: { lookup }, second: { lookup } };
    expect(() =>
      fromRpc(
        { feature: 'catalog', contract: nested, router: {} },
        {
          client: () => ({
            first: { lookup: () => Promise.resolve({ name: 'a' }) },
            second: { lookup: () => Promise.resolve({ name: 'b' }) },
          }),
        },
      ),
    ).toThrow('Duplicate MCP tool');
    expect(
      Object.keys(
        fromRpc(
          { feature: 'catalog', contract: nested, router: {} },
          {
            client: () => ({
              first: { lookup: () => Promise.resolve({ name: 'a' }) },
              second: { lookup: () => Promise.resolve({ name: 'b' }) },
            }),
            mountedPaths: [['second']],
          },
        ),
      ),
    ).toEqual(['catalog_lookup']);
  });
  it('keeps names prototype-safe, normalizes mounts and treats cancellation as a typed outcome', async () => {
    let calls = 0;
    const exposed = asTool(oc, { description: 'Inspect a mounted item.', access: 'public', effect: 'read' });
    const tools = fromRpc(
      { feature: 'Reports.EU#Two', contract: { inspect: exposed }, router: {} },
      {
        client: () => ({
          inspect: () => {
            calls++;
            return Promise.resolve({});
          },
        }),
      },
    );
    expect(Object.keys(tools)).toEqual(['reports_eu_two_inspect']);
    await tools.reports_eu_two_inspect.invoke({}, call);
    const controller = new AbortController();
    controller.abort();
    expect(await tools.reports_eu_two_inspect.invoke({}, { ...call, signal: controller.signal })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mcp.cancelled') }],
    });
    expect(calls).toBe(1);
    const named = asTool(oc, {
      description: 'Inspect a special name.',
      access: 'public',
      effect: 'read',
      name: '__proto__',
    });
    const special = fromRpc(
      { feature: 'catalog', contract: { inspect: named }, router: {} },
      {
        client: () => ({ inspect: () => Promise.resolve({}) }),
      },
    );
    expect(Object.keys(special)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(special)).toBe(Object.prototype);
    expect(toolResult({ rows: 'too large' }, 1)).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mcp.result_too_large') }],
    });
  });
  it('invokes callable native client proxies through a local RPC gateway', async () => {
    const nested = { group: { lookup } };
    const root = implement(nested).$context<{ owner: string }>();
    const router = root.router({
      group: {
        lookup: root.group.lookup.handler(({ context, input, errors }) =>
          orThrowRpc(
            input.id === 'missing' ? Missing({ id: input.id }) : { name: `${context.owner}:${input.id}` },
            errors,
          ),
        ),
      },
    });
    const handler = new RPCHandler(router);
    const native: ContractRouterClient<typeof nested> = createORPCClient(
      new RPCLink({
        url: 'http://fixture.local/rpc',
        fetch: async request => {
          const response = await handler.handle(request, { prefix: '/rpc', context: { owner: 'catalog' } });
          return response.response ?? new Response('Not found', { status: 404 });
        },
      }),
    );
    expect(typeof native).toBe('function');
    expect(typeof native.group).toBe('function');
    const tools = fromRpc({ feature: 'catalog', contract: nested, router }, { client: () => native });
    expect(await tools.catalog_lookup.run({ id: 'book' }, call)).toEqual({ name: 'catalog:book' });
    expect(await tools.catalog_lookup.run({ id: 'missing' }, call)).toMatchObject({
      code: 'catalog.missing',
      data: { id: 'missing' },
    });
  });

  it('caps tool budgets at the trusted call budget and counts text plus structured content', async () => {
    const limited = asTool(oc.input(z.object({ id: z.string() })).output(z.object({ name: z.string() })), {
      description: 'Find a budgeted item.',
      access: 'public',
      effect: 'read',
      budget: { maxChars: 8000 },
    });
    const tools = fromRpc(
      { feature: 'catalog', contract: { lookup: limited }, router: {} },
      {
        client: () => ({ lookup: () => Promise.resolve({ name: 'a'.repeat(100) }) }),
      },
    );
    expect(await tools.catalog_lookup.invoke({ id: 'book' }, { ...call, budget: { maxChars: 10 } })).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mcp.result_too_large') }],
    });
    const object = { name: 'book' };
    const size = JSON.stringify(object).length;
    expect(toolResult(object, size * 2 - 1)).toMatchObject({ isError: true });
    expect(toolResult(object, size * 2)).toMatchObject({ structuredContent: object });
  });

  it('scrubs malformed known error data and approval defects, and cancels approval waits', async () => {
    const malformed = fromRpc(
      { feature: 'catalog', contract, router: {} },
      {
        client: () => ({
          lookup: () => Promise.reject(new ORPCError('catalog.missing', { data: { id: 123 } })),
          privateLookup: input => Promise.resolve(input),
        }),
      },
    );
    expect(await malformed.catalog_lookup.run({ id: 'book' }, call)).toMatchObject({
      code: 'failure.invalid_envelope',
    });
    let executions = 0;
    const tools = fromRpc(
      {
        feature: 'catalog',
        contract: {
          remove: asTool(oc, {
            description: 'Remove an item.',
            access: 'public',
            effect: 'destructive',
            confirm: 'elicit',
          }),
        },
        router: {},
      },
      {
        client: () => ({
          remove: () => {
            executions++;
            return Promise.resolve({});
          },
        }),
      },
    );
    const defect = await tools.catalog_remove.invoke(
      {},
      { ...call, approve: () => Promise.reject(new Error('private secret')) },
    );
    expect(defect.isError).toBe(true);
    expect(JSON.stringify(defect)).not.toContain('private secret');
    const controller = new AbortController();
    expect(
      await tools.catalog_remove.run(
        {},
        {
          ...call,
          signal: controller.signal,
          approve: () => {
            controller.abort();
            return Promise.resolve(true);
          },
        },
      ),
    ).toMatchObject({ code: 'mcp.cancelled' });
    expect(executions).toBe(0);
  });
  it('rejects noncanonical executable error maps in types and at configuration', () => {
    const raw = asTool(oc.errors({ BUSINESS: { data: z.object({ id: z.string() }) } }), {
      description: 'Read a raw contract.',
      access: 'public',
      effect: 'read',
    });
    const rawEntry = { feature: 'catalog', contract: { nested: { raw } }, router: {} };
    const rawOptions = { client: () => ({ nested: { raw: () => Promise.resolve({}) } }) };
    expect(() => {
      // @ts-expect-error Exposed procedures must retain canonical definition references; C cannot widen from options.
      fromRpc(rawEntry, rawOptions);
    }).toThrow('error BUSINESS requires a canonical failure definition');
    const mismatch = asTool(oc.errors({ OTHER: errorMap(Missing)['catalog.missing'] }), {
      description: 'Read a mismatched contract.',
      access: 'public',
      effect: 'read',
    });
    const mismatchEntry = { feature: 'catalog', contract: { mismatch }, router: {} };
    const mismatchOptions = { client: () => ({ mismatch: () => Promise.resolve({}) }) };
    expect(() => {
      // @ts-expect-error The retained definition code must equal its error-map key.
      fromRpc(mismatchEntry, mismatchOptions);
    }).toThrow('error OTHER has a mismatched canonical failure definition');
    const hidden = asTool(oc.errors({ BUSINESS: {} }), {
      description: 'Inspect hidden configuration.',
      access: 'public',
      effect: 'read',
      hidden: true,
    });
    const unexposed = oc.errors({ BUSINESS: {} });
    expect(
      Object.keys(
        fromRpc(
          { feature: 'catalog', contract: { hidden, unexposed }, router: {} },
          {
            client: () => ({ hidden: () => Promise.resolve({}), unexposed: () => Promise.resolve({}) }),
          },
        ),
      ),
    ).toEqual([]);
  });
});

describe('fromRpc policy validation', () => {
  it('refuses a malformed meta.mcp when the tools are built, with the path of the procedure', () => {
    // Why: the policy is outside input (contract meta is plain data); a bad one must stop boot, not a call.
    const bad = oc
      .input(z.string())
      .output(z.string())
      .meta({ mcp: { description: 'x', access: 'everyone', effect: 'read' } });
    const router = implement({ bad }).router({ bad: implement({ bad }).bad.handler(({ input }) => input) });
    expect(() =>
      fromRpc({ feature: 'x', contract: { bad }, router }, { client: () => createRouterClient(router) }),
    ).toThrow('Invalid MCP policy at bad');
  });

  it('refuses a destructive tool with no confirmation', () => {
    const bad = oc
      .input(z.string())
      .output(z.string())
      .meta({ mcp: { description: 'x', access: 'user', effect: 'destructive' } });
    const router = implement({ bad }).router({ bad: implement({ bad }).bad.handler(({ input }) => input) });
    expect(() =>
      fromRpc({ feature: 'x', contract: { bad }, router }, { client: () => createRouterClient(router) }),
    ).toThrow('Invalid MCP policy at bad');
  });
});

describe('fromRpc exact adapter failures', () => {
  it('returns mcp.approval_required when a destructive call has no approver or the approver refuses', async () => {
    let executions = 0;
    const tools = fromRpc(
      {
        feature: 'catalog',
        router: {},
        contract: {
          remove: asTool(oc, {
            description: 'Remove an item.',
            access: 'public',
            effect: 'destructive',
            confirm: 'elicit',
          }),
        },
      },
      {
        client: () => ({
          remove: () => {
            executions++;
            return Promise.resolve({});
          },
        }),
      },
    );
    expect(await tools.catalog_remove.run(undefined, call)).toMatchObject({ code: 'mcp.approval_required' });
    expect(await tools.catalog_remove.run(undefined, { ...call, approve: () => false })).toMatchObject({
      code: 'mcp.approval_required',
    });
    expect(executions).toBe(0);
  });

  it('returns mcp.invalid_input when the model sends arguments the real router rejects', async () => {
    const root = implement({ lookup });
    const router = root.router({
      lookup: root.lookup.handler(({ input }) => ({ name: input.id })),
    });
    const client = createRouterClient(router);
    const tools = fromRpc({ feature: 'catalog', contract: { lookup }, router }, { client: () => client });
    const wrong: unknown = { id: 42 };
    // @ts-expect-error A model can send any JSON; the router must refuse it.
    const result = await tools.catalog_lookup.run(wrong, call);
    expect(result).toMatchObject({ code: 'mcp.invalid_input' });
  });

  it('returns mcp.internal when the tool output cannot be written as JSON', () => {
    expect(toolResult({ big: 1n }, 8000)).toMatchObject({
      isError: true,
      content: [{ text: expect.stringContaining('mcp.internal') }],
    });
  });
});
