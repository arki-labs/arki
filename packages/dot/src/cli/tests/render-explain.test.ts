/**
 * Tests for the explain renderer.
 *
 * Uses `testApp` to spin up synthetic plugins — no spawn, no temp dirs.
 */

import { describe, expect, it } from 'vitest';

import { defineApp } from '../../define-app.js';
import { plugin, service } from '../../plugin-contract.js';
import { runExplain } from '../explain.js';
import { renderExplainText } from '../render-explain.js';
import { textUi } from './text-ui.js';

function syntheticApp() {
  const db = plugin({
    name: 'db',
    version: '1.0.0',
    configure: ctx => {
      ctx.registerService('db', 'db');
    },
    provides: { db: () => ({ name: 'primary' }) },
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

describe('runExplain', () => {
  it("returns the manifest with all 6 arrays: it is the envelope's `.data`", async () => {
    const manifest = await runExplain(syntheticApp());
    if (!('manifestVersion' in manifest)) throw new Error('expected the manifest');

    expect(manifest.manifestVersion).toBe(2);
    // 6-array contract (manifest has plugins, actions, services, lifecycle, dependencies, projections)
    expect(manifest.plugins).toBeInstanceOf(Array);
    expect(manifest.actions).toBeInstanceOf(Array);
    expect(manifest.services).toBeInstanceOf(Array);
    expect(manifest.lifecycle).toBeInstanceOf(Array);
    expect(manifest.dependencies).toBeInstanceOf(Array);
    expect(manifest.projections).toBeInstanceOf(Array);

    // Substance
    expect(manifest.plugins.map(p => p.name)).toEqual(['db', 'api']);
    expect(manifest.services).toEqual([{ name: 'db', plugin: 'db', kind: 'db' }]);
    expect(manifest.actions).toEqual([
      { id: 'api.health', plugin: 'api', binding: 'http', direction: 'in', address: 'GET /health' },
    ]);
    expect(manifest.projections).toEqual([
      { format: 'openapi', binding: 'http', module: '@arki/http/projection', plugin: 'api' },
    ]);
  });

  it('returns dot.app_lifecycle_failed when configure throws, instead of throwing', async () => {
    const broken = plugin({
      name: 'broken',
      configure: () => {
        throw new Error('configure-boom');
      },
    });
    const result = await runExplain(defineApp('broken').use(broken));
    expect(result).toMatchObject({
      code: 'dot.app_lifecycle_failed',
      data: { phase: 'configure', causeMessage: expect.stringContaining('configure-boom') },
    });
    // Why: the cause may be any kernel code (ARKI_DOT_E020 is plugin order, not a
    // throwing hook), so the remediation must send the reader to that code's own fix.
    expect(result).toMatchObject({ remediation: expect.stringContaining('error.data.underlyingCode') });
  });

  it('snapshot stability: same app -> same JSON (no random ordering)', async () => {
    const first = JSON.stringify(await runExplain(syntheticApp()));
    const second = JSON.stringify(await runExplain(syntheticApp()));
    expect(first).toBe(second);
  });
});

describe('renderExplainText', () => {
  it('prints the summary line right after an action row, and nothing for an action without one', () => {
    const api = plugin({
      name: 'api',
      version: '1.0.0',
      configure: ctx => {
        ctx.registerAction({ id: 'api.plain', binding: 'http', direction: 'in', address: 'GET /plain' });
        ctx.registerAction({
          id: 'api.sweep',
          binding: 'schedule',
          direction: 'in',
          address: 'every 5m',
          summary: 'lock: one runner at a time',
        });
        ctx.registerAction({ id: 'api.after', binding: 'http', direction: 'in', address: 'GET /after' });
      },
    });
    const configured = defineApp('synthetic').use(api).configure();
    const { ui, text } = textUi();
    renderExplainText(configured.manifest, ui);
    const lines = text().split('\n');
    const sweep = lines.findIndex(line => line.includes('api.sweep'));
    expect(lines[sweep + 1]).toBe('      ↳ lock: one runner at a time');
    const plain = lines.findIndex(line => line.includes('api.plain'));
    expect(lines[plain + 1]).not.toContain('↳');
    expect(lines.filter(line => line.includes('↳'))).toHaveLength(1);
  });

  it('includes plugin names, service names, actions, and projections', () => {
    const configured = syntheticApp().configure();
    const { ui, text } = textUi();
    renderExplainText(configured.manifest, ui);
    const written = text();

    expect(written).toContain('synthetic');
    expect(written).toContain('db');
    expect(written).toContain('api');
    expect(written).toContain('Actions (1)');
    expect(written).toContain('api.health');
    expect(written).toContain('/health');
    expect(written).toContain('Projections (1)');
    expect(written).toContain('@arki/http/projection');
  });
});
