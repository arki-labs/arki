/**
 * Tests for the explain renderer.
 *
 * Uses `testApp` to spin up synthetic plugins — no spawn, no temp dirs.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../../define-app.js';
import { plugin, service } from '../../plugin-contract.js';
import { buildExplainEnvelope, renderExplain } from '../render-explain.js';

const FROZEN_NOW = () => new Date('2026-01-01T00:00:00.000Z');

function syntheticApp() {
  const db = plugin({
    name: 'db',
    version: '1.0.0',
    configure: ctx => {
      ctx.registerService('db', 'db');
    },
    boot: () => ({ db: { name: 'primary' } }),
  });
  const api = plugin({
    name: 'api',
    version: '1.0.0',
    needs: { db: service<{ name: string }>() },
    configure: ctx => {
      ctx.registerAction({
        id: 'api.health',
        binding: 'http',
        direction: 'in',
        address: 'GET /health',
      });
      ctx.registerProjection({ format: 'openapi', binding: 'http', module: '@arki/http/projection' });
    },
  });
  return defineApp('synthetic').use(db).use(api);
}

describe('buildExplainEnvelope', () => {
  it('emits a DotCliEnvelope with all 6 manifest arrays', () => {
    const configured = syntheticApp().configure();
    const envelope = buildExplainEnvelope({ manifest: configured.manifest }, { json: true, now: FROZEN_NOW });

    expect(envelope.status).toBe('success');
    expect(envelope.command).toBe('explain');
    expect(envelope.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(envelope.errors).toEqual([]);

    expect(envelope.data.manifestVersion).toBe(2);
    // 6-array contract (manifest has plugins, actions, services, lifecycle, dependencies, projections)
    expect(envelope.data.plugins).toBeInstanceOf(Array);
    expect(envelope.data.actions).toBeInstanceOf(Array);
    expect(envelope.data.services).toBeInstanceOf(Array);
    expect(envelope.data.lifecycle).toBeInstanceOf(Array);
    expect(envelope.data.dependencies).toBeInstanceOf(Array);
    expect(envelope.data.projections).toBeInstanceOf(Array);

    // Substance
    expect(envelope.data.plugins.map(p => p.name)).toEqual(['db', 'api']);
    expect(envelope.data.services).toEqual([{ name: 'db', plugin: 'db', kind: 'db' }]);
    expect(envelope.data.actions).toEqual([
      { id: 'api.health', plugin: 'api', binding: 'http', direction: 'in', address: 'GET /health' },
    ]);
    expect(envelope.data.projections).toEqual([
      { format: 'openapi', binding: 'http', module: '@arki/http/projection', plugin: 'api' },
    ]);
  });
});

describe('renderExplain', () => {
  it('JSON mode writes a parseable envelope to the sink', () => {
    const configured = syntheticApp().configure();
    let written = '';
    const envelope = renderExplain(
      { manifest: configured.manifest },
      { json: true, now: FROZEN_NOW, out: line => (written += line) },
    );

    expect(written.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(written) as typeof envelope;
    expect(parsed.status).toBe('success');
    expect(parsed.command).toBe('explain');
    expect(parsed.data.app.name).toBe('synthetic');
  });

  it('text mode includes plugin names, service names, actions, and projections', () => {
    const configured = syntheticApp().configure();
    let written = '';
    renderExplain({ manifest: configured.manifest }, { json: false, now: FROZEN_NOW, out: line => (written += line) });

    expect(written).toContain('synthetic');
    expect(written).toContain('db');
    expect(written).toContain('api');
    expect(written).toContain('Actions (1)');
    expect(written).toContain('api.health');
    expect(written).toContain('/health');
    expect(written).toContain('Projections (1)');
    expect(written).toContain('@arki/http/projection');
  });

  it('snapshot stability: same app → same JSON (no random ordering)', () => {
    const configured1 = syntheticApp().configure();
    const configured2 = syntheticApp().configure();
    let first = '';
    let second = '';
    renderExplain(
      { manifest: configured1.manifest },
      { json: true, now: FROZEN_NOW, out: line => (first += line) },
    );
    renderExplain(
      { manifest: configured2.manifest },
      { json: true, now: FROZEN_NOW, out: line => (second += line) },
    );
    expect(first).toBe(second);
  });

  it('reports status=success on a valid configured app', () => {
    const configured = syntheticApp().configure();
    let written = '';
    const envelope = renderExplain(
      { manifest: configured.manifest },
      { json: true, now: FROZEN_NOW, out: line => (written += line) },
    );
    expect(envelope.status).toBe('success');
  });
});
