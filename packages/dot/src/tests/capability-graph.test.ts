/**
 * The capability graph is data before boot. A feature's `provides` keys
 * are static, so the kernel checks every feature-to-feature need when the
 * app is assembled (configure time) and `dot explain` draws the edges
 * without booting anything. These tests encode why that matters: a ring
 * or a misordered provider must fail with an error that names the fix,
 * not the generic "no earlier unit provides it" (E012) at boot.
 */
import { describe, expect, it } from 'vitest';

import { orThrow, UnexpectedDefect } from '@arki/failure';

import { runExplain } from '../cli/index.js';
import { renderExplainText } from '../cli/render-explain.js';
import { textUi } from '../cli/tests/text-ui.js';
import { defineApp } from '../define-app.js';
import { feature } from '../feature.js';
import { DotLifecycleErrorCode } from '../lifecycle.js';
import { infra, service, token } from '../unit-contract.js';

type Db = { readonly tag: 'db' };
type Scorer = { readonly score: (text: string) => number };
type Intelligence = { readonly summarize: (text: string) => string };

const db = infra({ name: 'db', provides: { db: () => ({ tag: 'db' as const }) } });

describe('configure-time capability checks', () => {
  it('a ring among erased features fails configure() with E019 printing the ring in order', () => {
    // Typed feature modules naming each other's handles never get here (TS7022 /
    // TDZ fire first); erased graphs and JS modules do. Witnesses by wire key
    // are exactly that erased shape.
    const summarization = feature('ai-summarization', {
      needs: { scorer: token<Scorer>()('scorer') },
      provides: { intelligence: ({ scorer }): Intelligence => ({ summarize: text => `${scorer.score(text)}` }) },
    });
    const scoring = feature('relevance-scoring', {
      needs: { intelligence: token<Intelligence>()('intelligence') },
      provides: { scorer: ({ intelligence }): Scorer => ({ score: text => intelligence.summarize(text).length }) },
    });
    // @ts-expect-error -- the tuple guard rejects it too: scorer is provided after its consumer
    const ring = defineApp('ring').infra(db).features([summarization, scoring]);

    expect(ring.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.CapabilityRing,
        phase: 'configure',
        plugin: 'ai-summarization',
        message: [
          'Feature "ai-summarization" needs "scorer", which comes back around to itself:',
          '  ai-summarization needs scorer ← relevance-scoring needs intelligence ← ai-summarization',
          'Break the ring: move the shared piece into a third feature both need, or let one side read through db.query instead of a handle.',
        ].join('\n'),
      },
    });
  });

  it('a provider mounted after its consumer fails configure() with E020 naming both positions and the fix', () => {
    const billing = feature('billing', { provides: { entitlements: () => ({ plan: 'pro' as const }) } });
    const digest = feature('daily-digest', { needs: { access: billing.provides.entitlements } });
    // @ts-expect-error -- the tuple guard rejects the same order at compile time
    const misordered = defineApp('order').infra(db).features([digest, billing]);

    expect(misordered.configure()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: {
        code: DotLifecycleErrorCode.ProviderMountedLater,
        phase: 'configure',
        plugin: 'daily-digest',
        message: [
          'Feature "daily-digest" needs "entitlements", which "billing" provides — but "billing" is mounted after it (position 3; "daily-digest" is 2).',
          'Move "billing" before "daily-digest" in .features([...]).',
        ].join('\n'),
      },
    });
  });
});

describe('dot explain', () => {
  it('lists capability edges and provides without booting — explain never boots', async () => {
    let built = 0;
    const billing = feature('billing', {
      needs: { db: service<Db>() },
      provides: {
        entitlements: () => {
          built += 1;
          return { plan: 'pro' as const };
        },
      },
    });
    const digest = feature('daily-digest', { needs: { access: billing.provides.entitlements, db: service<Db>() } });
    const builder = defineApp('explain-edges').infra(db).features([billing, digest]);

    const explained = textUi();
    renderExplainText(orThrow(builder.configure()).manifest, explained.ui);
    const table = explained.text();
    const manifest = await runExplain(orThrow(builder.configure()));
    const graphed = await runExplain(orThrow(builder.configure()), { graph: true });
    const graph = 'source' in graphed ? graphed.source : '';

    expect(built).toBe(0);
    expect(table).toContain('daily-digest --[entitlements]--> billing');
    expect(graph).toContain('p2 -->|entitlements| p1');
    expect(manifest).toMatchObject({ manifestVersion: 2 });
    const configured = orThrow(builder.configure());
    expect(configured.manifest.plugins.find(p => p.name === 'billing')?.provides).toEqual([
      'entitlements',
      'feature.billing',
    ]);
    // Adapters (`.infra(db)`) are drawn too: their provides are static handles.
    expect(table).toContain('daily-digest --[db]--> db');
    expect(configured.manifest.dependencies).toEqual([
      { from: 'billing', to: 'db', kind: 'requires', key: 'db' },
      { from: 'daily-digest', to: 'billing', kind: 'requires', key: 'entitlements' },
      { from: 'daily-digest', to: 'db', kind: 'requires', key: 'db' },
    ]);
  });
});
