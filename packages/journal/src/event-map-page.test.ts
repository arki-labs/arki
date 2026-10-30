/**
 * The event map page in the `dot dev` console is drawn from the same document as `dot explain --as event-map`.
 *
 * Why these tests exist: a page that silently drops a node or an edge tells a reader that nothing happens
 * where something does. So they compare the page with the document, one id and one edge at a time, on the
 * fixture app that has every kind of edge. They also pin what a stranger's data cannot do to the page (break
 * out of the script) and that a scan problem is on the page in plain words.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { orThrow } from '@arki/failure';

import type { EventMapDocument } from './projection.js';
import { journal, journalWorker } from './dot.js';
import { consolePage, project } from './event-map.js';
import { eventMapMermaid } from './projection.js';
import { flowOf } from './event-map-flow.js';
import { featuresOf, layoutEventMap, ownersOf } from './event-map-layout.js';
import { ordersFeature } from './fixtures/event-map/app/src/features/orders/feature.js';
import { paymentsFeature } from './fixtures/event-map/app/src/features/payments/feature.js';
import { dbUnit } from './fixtures/event-map/app/src/db.js';
import { j } from './fixtures/event-map/app/src/journal.js';

const appFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/event-map/app');

async function fixtureDocument(): Promise<EventMapDocument> {
  const { manifest } = orThrow(
    defineApp('event-map-fixture')
      .infra(dbUnit, journal({ j, workflowMeta: { actorId: 'system:workflow' } }))
      .features([ordersFeature, paymentsFeature])
      .entrypoints(journalWorker())
      .configure(),
  );
  return project(manifest, appFolder);
}

/** The first `<svg ... data-view="">` of the page: the whole graph. */
function wholeView(page: string): string {
  const start = page.indexOf('<svg class="map" data-view=""');
  return page.slice(start, page.indexOf('</svg>', start));
}

describe('the console page for the fixture app', () => {
  it('draws every node and every edge of the document, none twice', async () => {
    const document = await fixtureDocument();
    const view = wholeView(consolePage(document));
    const drawnNodes = [...view.matchAll(/class="node [^"]*" data-id="([^"]+)"/g)].map(match => match[1]);
    const drawnEdges = [...view.matchAll(/data-index="(\d+)" data-source="([^"]+)" data-target="([^"]+)"/g)].map(match => ({
      index: Number(match[1]),
      from: match[2],
      to: match[3],
    }));
    // A feature is an owner (a filter option and a line in the details), not a box; an `owned-by` edge is that owner line.
    expect(drawnNodes.toSorted()).toEqual(
      document.nodes
        .filter(node => node.kind !== 'feature')
        .map(node => node.id.replaceAll('&', '&amp;'))
        .toSorted(),
    );
    expect(drawnEdges).toEqual(
      document.edges.flatMap((edge, index) =>
        edge.kind === 'owned-by' ? [] : [{ index, from: flowOf(edge).source, to: flowOf(edge).target }],
      ),
    );
    expect(document.edges.filter(edge => edge.kind !== 'owned-by').length).toBeGreaterThan(10);
  });

  // Why: two views that draw the same edge in opposite directions send a reader the wrong way. Both read `flowOf`.
  it('draws every arrow the way the Mermaid view does, and the arrows from an event point at its consumers', async () => {
    const document = await fixtureDocument();
    const mermaidId = (id: string): string => id.replaceAll(/[^a-z0-9]/gi, '_');
    const fromMermaid = [...eventMapMermaid(document).matchAll(/^ {2}(\S+) -[-.] .* [-.]-?> (\S+)$/gm)]
      .map(match => `${match[1]} ${match[2]}`)
      .toSorted();
    const fromPage = [...wholeView(consolePage(document)).matchAll(/data-source="([^"]+)" data-target="([^"]+)"/g)]
      .map(match => `${mermaidId(match[1] ?? '')} ${mermaidId(match[2] ?? '')}`)
      .toSorted();
    expect(fromPage).toEqual(fromMermaid);
    expect(fromPage.length).toBeGreaterThan(10);
    expect(fromPage).toContain('event_OrderPlaced entity_order');
    expect(fromPage).toContain('command_place_order event_OrderPlaced');
    expect(fromPage).toContain('workflow_checkout_1 command_charge_payment');
    expect(fromPage).not.toContain('entity_order event_OrderPlaced');
  });

  it('puts the columns in reading order: entrypoints, commands, events, then what consumes them', async () => {
    const layout = layoutEventMap(await fixtureDocument());
    const column = (kind: string): number[] =>
      [...new Set(layout.nodes.filter(placed => placed.node.kind === kind).map(placed => placed.column))];
    expect([column('entrypoint'), column('command'), column('event'), column('effect'), column('workflow')]).toEqual([
      [0],
      [1],
      [2],
      [3],
      [3],
    ]);
  });

  it('has one view per feature that shows its nodes and marks the other features context only', async () => {
    const document = await fixtureDocument();
    const owners = ownersOf(document);
    expect(featuresOf(document)).toEqual(['orders', 'payments']);
    for (const feature of featuresOf(document)) {
      const layout = layoutEventMap(document, feature);
      const owned = document.nodes.filter(node => owners.get(node.id) === feature && node.kind !== 'feature');
      expect(owned.length).toBeGreaterThan(0);
      for (const node of owned) {
        const placed = layout.nodes.find(candidate => candidate.node.id === node.id);
        expect(placed?.context, `${node.id} in ${feature}`).toBe(false);
      }
      for (const placed of layout.nodes)
        if (owners.get(placed.node.id) !== feature) expect(placed.context).toBe(true);
    }
  });

  it('shows a file the scan could not read, with its reason', async () => {
    const document = await fixtureDocument();
    const page = consolePage({
      ...document,
      problems: [{ file: 'orders/entrypoints/broken.ts', reason: 'cannot import: unexpected token' }],
    });
    expect(page).toContain('orders/entrypoints/broken.ts');
    expect(page).toContain('cannot import: unexpected token');
    expect(consolePage(document)).not.toContain('class="problems"');
  });

  it('cannot be broken out of by a name', async () => {
    const document = await fixtureDocument();
    const hostile = '</script><img src=x onerror=alert(1)>';
    const page = consolePage({
      ...document,
      nodes: [...document.nodes, { id: `event:${hostile}`, kind: 'event', name: hostile }],
    });
    expect(page).not.toContain('<img src=x');
    expect(page.match(/<\/script>/g)?.length).toBe(2);
  });

  it('says so when the document is not an event map', () => {
    expect(consolePage({ format: 'openapi' })).toContain('not an event-map document');
  });
});
