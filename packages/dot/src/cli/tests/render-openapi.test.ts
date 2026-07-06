/**
 * Tests for `--openapi` rendering.
 *
 * Unit layer: `buildOpenApiDocument` builds OpenAPI 3.1 from manifest
 * routes — path conversion, per-location schemas, streaming responses,
 * non-http transports skipped. Arg layer: `--openapi` is explain-only and
 * mutually exclusive with `--graph`.
 */

import { describe, expect, it } from 'vitest';

import type { DotAppManifest } from '../../manifest.js';
import { parseArgs } from '../index.js';
import { buildOpenApiDocument, renderOpenApi } from '../render-openapi.js';

function manifestOf(overrides: Partial<DotAppManifest>): DotAppManifest {
  return {
    app: { name: 'shop-api', version: '1.0.0' },
    pips: [],
    services: [],
    routes: [],
    dependencies: [],
    lifecycle: [],
    ...overrides,
  };
}

describe('buildOpenApiDocument', () => {
  it('renders routes with path params, query params, body, and output schemas', () => {
    const manifest = manifestOf({
      routes: [
        {
          id: 'orders.get',
          pip: 'orders',
          method: 'GET',
          path: '/orders/:id',
          transport: 'http',
          description: 'Fetch one order',
          input: {
            query: {
              type: 'object',
              properties: { expand: { type: 'string' } },
              required: ['expand'],
            },
          },
          output: { type: 'object', properties: { id: { type: 'string' } } },
        },
        {
          id: 'orders.create',
          pip: 'orders',
          method: 'POST',
          path: '/orders',
          transport: 'http',
          input: { body: { type: 'object', properties: { sku: { type: 'string' } } } },
        },
      ],
    });

    const document = buildOpenApiDocument(manifest);
    expect(document['openapi']).toBe('3.1.0');
    expect(document['info']).toEqual({ title: 'shop-api', version: '1.0.0' });

    const paths = document['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    const getOp = paths['/orders/{id}']!['get']!;
    expect(getOp['operationId']).toBe('orders.get');
    expect(getOp['summary']).toBe('Fetch one order');
    expect(getOp['tags']).toEqual(['orders']);
    expect(getOp['parameters']).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'expand', in: 'query', required: true, schema: { type: 'string' } },
    ]);
    expect(getOp['responses']).toMatchObject({
      '200': { content: { 'application/json': { schema: { type: 'object' } } } },
    });

    const postOp = paths['/orders']!['post']!;
    expect(postOp['requestBody']).toMatchObject({
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    });
    expect(postOp['responses']).toEqual({ '200': { description: 'success' } });
  });

  it('renders streaming routes as text/event-stream and skips non-http transports', () => {
    const manifest = manifestOf({
      routes: [
        {
          id: 'orders.progress',
          pip: 'orders',
          method: 'GET',
          path: '/orders/:id/progress',
          transport: 'http',
          streaming: true,
          output: { type: 'object', properties: { type: { type: 'string' } } },
        },
        { id: 'rpc', pip: 'api', path: '/rpc', transport: 'orpc' },
      ],
    });

    const paths = buildOpenApiDocument(manifest)['paths'] as Record<string, Record<string, Record<string, unknown>>>;
    expect(paths['/rpc']).toBeUndefined();
    expect(paths['/orders/{id}/progress']!['get']!['responses']).toMatchObject({
      '200': {
        description: 'event stream',
        content: { 'text/event-stream': { schema: { type: 'object' } } },
      },
    });
  });

  it('is deterministic — same manifest, byte-identical output', () => {
    const manifest = manifestOf({
      routes: [
        { id: 'a', pip: 'p', method: 'GET', path: '/a', transport: 'http' },
        { id: 'b', pip: 'p', method: 'POST', path: '/a', transport: 'http' },
      ],
    });
    expect(JSON.stringify(buildOpenApiDocument(manifest))).toBe(JSON.stringify(buildOpenApiDocument(manifest)));
  });
});

describe('renderOpenApi', () => {
  it('plain mode prints the document; --json wraps it in the standard envelope', () => {
    const manifest = manifestOf({
      routes: [{ id: 'a', pip: 'p', method: 'GET', path: '/a', transport: 'http' }],
    });

    const plainLines: string[] = [];
    renderOpenApi(
      { manifest, command: 'explain' },
      { json: false, out: line => plainLines.push(line), now: () => new Date(0) },
    );
    expect((JSON.parse(plainLines.join('')) as Record<string, unknown>)['openapi']).toBe('3.1.0');

    const jsonLines: string[] = [];
    const envelope = renderOpenApi(
      { manifest, command: 'explain' },
      { json: true, out: line => jsonLines.push(line), now: () => new Date(0) },
    );
    expect(envelope).toMatchObject({
      status: 'success',
      command: 'explain',
      generatedAt: '1970-01-01T00:00:00.000Z',
      data: { format: 'openapi' },
    });
    expect(JSON.parse(jsonLines.join('')) as unknown).toMatchObject({ data: { format: 'openapi' } });
  });
});

describe('--openapi arg parsing', () => {
  it('parses on explain and defaults to false', () => {
    expect(parseArgs(['explain', '--openapi']).openapi).toBe(true);
    expect(parseArgs(['explain']).openapi).toBe(false);
  });

  it('rejects --openapi with --graph', () => {
    expect(() => parseArgs(['explain', '--openapi', '--graph'])).toThrow(/mutually exclusive/);
  });

  it('rejects --openapi on doctor', () => {
    expect(() => parseArgs(['doctor', '--openapi'])).toThrow(/not supported by doctor/);
  });
});
