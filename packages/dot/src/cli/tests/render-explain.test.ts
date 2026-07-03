/**
 * Tests for the explain renderer.
 *
 * Uses `testApp` to spin up synthetic pips — no spawn, no temp dirs.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../../define-app.js';
import { pip, service } from '../../pip-contract.js';
import { buildExplainEnvelope, renderExplain } from '../render-explain.js';

const FROZEN_NOW = () => new Date('2026-01-01T00:00:00.000Z');

function syntheticApp() {
  const db = pip({
    name: 'db',
    version: '1.0.0',
    configure: ctx => {
      ctx.registerService('db', 'db');
    },
    boot: () => ({ db: { name: 'primary' } }),
  });
  const api = pip({
    name: 'api',
    version: '1.0.0',
    needs: { db: service<{ name: string }>() },
    configure: ctx => {
      ctx.registerRoute({ id: 'api.health', method: 'GET', path: '/health', transport: 'http' });
    },
  });
  return defineApp('synthetic').use(db).use(api);
}

describe('buildExplainEnvelope', () => {
  it('emits a DotCliEnvelope with all 5 manifest arrays', () => {
    const configured = syntheticApp().configure();
    const envelope = buildExplainEnvelope({ manifest: configured.manifest }, { json: true, now: FROZEN_NOW });

    expect(envelope.status).toBe('success');
    expect(envelope.command).toBe('explain');
    expect(envelope.generatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(envelope.errors).toEqual([]);

    // 5-array contract (manifest has pips, routes, services, lifecycle, dependencies)
    expect(envelope.data.pips).toBeInstanceOf(Array);
    expect(envelope.data.routes).toBeInstanceOf(Array);
    expect(envelope.data.services).toBeInstanceOf(Array);
    expect(envelope.data.lifecycle).toBeInstanceOf(Array);
    expect(envelope.data.dependencies).toBeInstanceOf(Array);

    // Substance
    expect(envelope.data.pips.map(p => p.name)).toEqual(['db', 'api']);
    expect(envelope.data.services).toEqual([{ name: 'db', pip: 'db', kind: 'db' }]);
    expect(envelope.data.routes).toEqual([
      { id: 'api.health', pip: 'api', method: 'GET', path: '/health', transport: 'http' },
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

  it('text mode includes pip names, service names, and route entries', () => {
    const configured = syntheticApp().configure();
    let written = '';
    renderExplain({ manifest: configured.manifest }, { json: false, now: FROZEN_NOW, out: line => (written += line) });

    expect(written).toContain('synthetic');
    expect(written).toContain('db');
    expect(written).toContain('api');
    expect(written).toContain('api.health');
    expect(written).toContain('/health');
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
