/**
 * OpenAPI generation and manifest metadata: schema conversion, path
 * translation, SSE content types, determinism, and collision rejection.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { route } from '../contract.js';
import { HTTP_ERROR_CODES } from '../error.js';
import { contractMeta, toOpenApi, toOpenApiFromManifest } from '../openapi.js';
import { optional } from '../wire.js';

const getOrder = route.get('/orders/:id', {
  id: 'orders.get',
  summary: 'Fetch one order',
  query: { expand: optional(z.enum(['items', 'none'])) },
  output: z.object({ id: z.string() }),
});

const createOrder = route.post('/orders', {
  id: 'orders.create',
  body: z.object({ sku: z.string() }),
  output: z.object({ id: z.string() }),
});

const progress = route.sse('/orders/:id/progress', {
  id: 'orders.progress',
  event: z.object({ step: z.number() }),
});

describe('toOpenApi', () => {
  it('renders paths, parameters, request bodies, and responses from contracts', () => {
    const document = toOpenApi([getOrder, createOrder, progress], { title: 'shop', version: '1.0.0' });
    expect(document['openapi']).toBe('3.1.0');

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths)).toEqual(['/orders/{id}', '/orders', '/orders/{id}/progress']);

    const getOp = paths['/orders/{id}']!['get']!;
    expect(getOp['operationId']).toBe('orders.get');
    expect(getOp['summary']).toBe('Fetch one order');
    const parameters = getOp['parameters'] as { name: string; in: string; required: boolean }[];
    expect(parameters[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(parameters[1]).toMatchObject({ name: 'expand', in: 'query', required: false });

    expect(paths['/orders']!['post']!['requestBody']).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    });

    expect(paths['/orders/{id}/progress']!['get']!['responses']).toMatchObject({
      '200': { content: { 'text/event-stream': { schema: { type: 'object' } } } },
    });
  });

  it('is deterministic — same contracts, byte-identical output', () => {
    const contracts = [getOrder, createOrder, progress];
    const info = { title: 'shop', version: '1.0.0' };
    expect(JSON.stringify(toOpenApi(contracts, info))).toBe(JSON.stringify(toOpenApi(contracts, info)));
  });

  it('rejects duplicate method+path pairs', () => {
    const dup = route.get('/orders/:id', { id: 'orders.get2' });
    try {
      toOpenApi([getOrder, dup], { title: 'shop', version: '1.0.0' });
      expect.unreachable('duplicate contract must throw');
    } catch (error) {
      expect(error).toMatchObject({ code: HTTP_ERROR_CODES.duplicateRoute });
    }
  });
});

describe('contractMeta', () => {
  it('converts schemas to JSON Schema without the $schema dialect header', () => {
    const meta = contractMeta(createOrder);
    expect(meta).toMatchObject({
      id: 'orders.create',
      binding: 'http',
      direction: 'in',
      address: 'POST /orders',
      metaSchema: '@arki/http/action-meta@1',
    });
    expect(meta.meta).toMatchObject({
      input: { body: { type: 'object', properties: { sku: { type: 'string' } } } },
    });
    expect(JSON.stringify(meta.meta)).not.toContain('$schema');
    expect(meta.meta['output']).toMatchObject({ type: 'object' });
    expect(meta.meta['streaming']).toBeUndefined();
  });

  it('marks sse contracts streaming and carries the event schema as output', () => {
    const meta = contractMeta(progress);
    expect(meta.meta['streaming']).toBe(true);
    expect(meta.meta['output']).toMatchObject({ type: 'object', properties: { step: { type: 'number' } } });
  });

  it('is exposed structurally through toDotAction on contracts', () => {
    expect(createOrder.toDotAction()).toEqual(contractMeta(createOrder));
  });
});

describe('toOpenApiFromManifest', () => {
  it('renders OpenAPI from HTTP actions and skips other bindings', () => {
    const document = toOpenApiFromManifest({
      app: { name: 'shop-api', version: '1.0.0' },
      actions: [
        { ...getOrder.toDotAction(), plugin: 'orders' },
        { ...createOrder.toDotAction(), plugin: 'orders' },
        { id: 'jobs.run', plugin: 'jobs', binding: 'queue', direction: 'in' },
      ],
    });

    expect(document['openapi']).toBe('3.1.0');
    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(Object.keys(paths)).toEqual(['/orders/{id}', '/orders']);
    expect(paths['/orders/{id}']!['get']!).toMatchObject({
      operationId: 'orders.get',
      tags: ['orders'],
      summary: 'Fetch one order',
    });
  });
});
