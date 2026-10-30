/**
 * The event map: the graph `dot explain --as event-map` builds from one fixture app (orders and payments), and
 * its three outputs. The fixture has every kind of edge: commands that write events, a fold, a projection, an
 * effect and a tap, a workflow started after commit with a command node, an `undo`, an event wait and a
 * `.parallel`, a workflow started with the event, and procedure files the scan reads.
 *
 * Why these tests exist: the map is how a reader (or an agent) learns what an event causes. A missing edge is
 * a lie of omission, so the graph is compared whole, and the text and Mermaid views are committed files: a change
 * to either is a visible diff in review.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { defineApp } from '@arki/dot';
import { orThrow } from '@arki/failure';

import type { EventMapEdge, EventMapNode } from './projection.js';
import { journal, journalWorker } from './dot.js';
import { checkEventMapFile, project, render, scanEntrypoints } from './event-map.js';
import { ordersFeature } from './fixtures/event-map/app/src/features/orders/feature.js';
import { paymentsFeature } from './fixtures/event-map/app/src/features/payments/feature.js';
import { dbUnit } from './fixtures/event-map/app/src/db.js';
import { j } from './fixtures/event-map/app/src/journal.js';
import { eventMapMermaid } from './projection.js';

const appFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/event-map/app');
const sandboxes: string[] = [];

afterAll(async () => {
  for (const folder of sandboxes) await rm(folder, { recursive: true, force: true });
});

/** The fixture app configured, not booted: the manifest is all `dot explain` reads. */
function fixtureManifest(entrypointRoot?: string) {
  return orThrow(
    defineApp('event-map-fixture')
      .infra(
        dbUnit,
        journal({ j, workflowMeta: { actorId: 'system:workflow' }, ...(entrypointRoot === undefined ? {} : { entrypointRoot }) }),
      )
      .features([ordersFeature, paymentsFeature])
      .entrypoints(journalWorker())
      .configure(),
  ).manifest;
}

const expectedNodes: EventMapNode[] = [
  {'id': 'feature:orders', 'kind': 'feature', 'name': 'orders'},
  {'id': 'entity:order', 'kind': 'entity', 'name': 'order', 'table': 'orders'},
  {'id': 'event:OrderPlaced', 'kind': 'event', 'name': 'OrderPlaced'},
  {'id': 'event:OrderCancelled', 'kind': 'event', 'name': 'OrderCancelled'},
  {'id': 'effect:send-receipt', 'kind': 'effect', 'name': 'send-receipt', 'deps': ['mailer'], 'retry': {'policy': 'default', 'maxRetries': 7}},
  {'id': 'tap:order-feed', 'kind': 'tap', 'name': 'order-feed', 'deps': []},
  {'id': 'projection:order-count', 'kind': 'projection', 'name': 'order-count', 'lane': 'inline'},
  {'id': 'feature:payments', 'kind': 'feature', 'name': 'payments'},
  {'id': 'workflow:checkout@1', 'kind': 'workflow', 'name': 'checkout', 'version': 1, 'deps': [], 'signals': [], 'opaqueSteps': ['notify.mail.send-mail', 'log']},
  {'id': 'command:charge-payment', 'kind': 'command', 'name': 'charge-payment'},
  {'id': 'event:PaymentSettled', 'kind': 'event', 'name': 'PaymentSettled'},
  {'id': 'command:refund-payment', 'kind': 'command', 'name': 'refund-payment'},
  {'id': 'event:PaymentRefunded', 'kind': 'event', 'name': 'PaymentRefunded'},
  {'id': 'entity:payment', 'kind': 'entity', 'name': 'payment', 'table': 'payments'},
  {'id': 'command:cancel-order', 'kind': 'command', 'name': 'cancel-order'},
  {'id': 'workflow:reserve-stock@1', 'kind': 'workflow', 'name': 'reserve-stock', 'version': 1, 'deps': [], 'signals': [], 'opaqueSteps': ['hold']},
  {'id': 'entrypoint:orders/entrypoints/rpc.ts', 'kind': 'entrypoint', 'name': 'orders/entrypoints/rpc.ts', 'feature': 'orders', 'file': 'orders/entrypoints/rpc.ts'},
  {'id': 'command:place-order', 'kind': 'command', 'name': 'place-order'},
  {'id': 'entrypoint:payments/entrypoints/webhook.ts', 'kind': 'entrypoint', 'name': 'payments/entrypoints/webhook.ts', 'feature': 'payments', 'file': 'payments/entrypoints/webhook.ts'},
];
const expectedEdges: EventMapEdge[] = [
  {'kind': 'folds', 'from': 'entity:order', 'to': 'event:OrderPlaced', 'timing': 'same-transaction'},
  {'kind': 'folds', 'from': 'entity:order', 'to': 'event:OrderCancelled', 'timing': 'same-transaction'},
  {'kind': 'reacts', 'from': 'effect:send-receipt', 'to': 'event:OrderPlaced', 'timing': 'after-commit', 'delivery': 'at-least-once'},
  {'kind': 'owned-by', 'from': 'effect:send-receipt', 'to': 'feature:orders'},
  {'kind': 'reacts', 'from': 'tap:order-feed', 'to': 'event:OrderPlaced', 'timing': 'after-commit', 'delivery': 'at-most-once'},
  {'kind': 'owned-by', 'from': 'tap:order-feed', 'to': 'feature:orders'},
  {'kind': 'projects', 'from': 'projection:order-count', 'to': 'event:OrderPlaced', 'timing': 'same-transaction'},
  {'kind': 'owned-by', 'from': 'projection:order-count', 'to': 'feature:orders'},
  {'kind': 'writes', 'from': 'command:charge-payment', 'to': 'event:PaymentSettled'},
  {'kind': 'runs', 'from': 'workflow:checkout@1', 'to': 'command:charge-payment', 'node': 'charge'},
  {'kind': 'writes', 'from': 'command:refund-payment', 'to': 'event:PaymentRefunded'},
  {'kind': 'runs', 'from': 'workflow:checkout@1', 'to': 'command:refund-payment', 'node': 'charge', 'undo': true},
  {'kind': 'folds', 'from': 'entity:payment', 'to': 'event:PaymentSettled', 'timing': 'same-transaction'},
  {'kind': 'folds', 'from': 'entity:payment', 'to': 'event:PaymentRefunded', 'timing': 'same-transaction'},
  {'kind': 'waits-for', 'from': 'workflow:checkout@1', 'to': 'event:PaymentSettled', 'node': 'confirm', 'label': 'settled'},
  {'kind': 'writes', 'from': 'command:cancel-order', 'to': 'event:OrderCancelled'},
  {'kind': 'runs', 'from': 'workflow:checkout@1', 'to': 'command:cancel-order', 'node': 'notify.push.release'},
  {'kind': 'reacts', 'from': 'workflow:checkout@1', 'to': 'event:OrderPlaced', 'timing': 'after-commit', 'delivery': 'at-least-once'},
  {'kind': 'owned-by', 'from': 'workflow:checkout@1', 'to': 'feature:payments'},
  {'kind': 'reacts', 'from': 'workflow:reserve-stock@1', 'to': 'event:OrderPlaced', 'timing': 'same-transaction'},
  {'kind': 'owned-by', 'from': 'workflow:reserve-stock@1', 'to': 'feature:payments'},
  {'kind': 'calls', 'from': 'entrypoint:orders/entrypoints/rpc.ts', 'to': 'command:cancel-order'},
  {'kind': 'writes', 'from': 'command:place-order', 'to': 'event:OrderPlaced'},
  {'kind': 'calls', 'from': 'entrypoint:orders/entrypoints/rpc.ts', 'to': 'command:place-order'},
  {'kind': 'calls', 'from': 'entrypoint:payments/entrypoints/webhook.ts', 'to': 'command:charge-payment'},
  {'kind': 'calls', 'from': 'entrypoint:payments/entrypoints/webhook.ts', 'to': 'command:refund-payment'},
];

describe('the fixture app: dot explain --as event-map', () => {
  it('has exactly these nodes and edges: every edge kind, from declarations and from the scan', async () => {
    const document = await project(fixtureManifest(), appFolder);
    expect(document.problems).toEqual([]);
    expect(document.nodes).toEqual(expectedNodes);
    expect(document.edges).toEqual(expectedEdges);
  });

  it('prints the text view committed in the fixture', async () => {
    const text = render(await project(fixtureManifest(), appFolder));
    await expect(`${text}\n`).toMatchFileSnapshot('./fixtures/event-map/app/event-map.txt');
  });

  // Why: this is the file an app keeps in its docs. It changes only when the app's events, commands or handlers do.
  it('keeps the Mermaid file in the fixture fresh', async () => {
    const mermaid = eventMapMermaid(await project(fixtureManifest(), appFolder));
    const checked = await checkEventMapFile({
      file: path.join(appFolder, 'docs/event-map.mmd'),
      mermaid,
      update: process.env['EVENT_MAP_UPDATE'] === '1',
    });
    expect(checked).toEqual({ state: 'fresh' });
  });

  it('keeps the scan root of the app that names one, and reads nothing when that folder is missing', async () => {
    const document = await project(fixtureManifest('src/nowhere'), appFolder);
    expect(document.nodes.some(node => node.kind === 'entrypoint')).toBe(false);
    expect(document.problems).toEqual([{ file: '.', reason: expect.stringMatching(/cannot read the folder/) }]);
  });
});

describe('eventMapMermaid(document)', () => {
  // Why: the file lives in git. If the order followed the order the graph was built in, an unrelated refactor
  // would rewrite it.
  it('prints the same text for the same graph however its nodes and edges are ordered', async () => {
    const document = await project(fixtureManifest(), appFolder);
    const shuffled = { nodes: document.nodes.toReversed(), edges: document.edges.toReversed() };
    expect(eventMapMermaid(shuffled)).toBe(eventMapMermaid(document));
  });

  it('draws data flow: command to event, event to its consumers, and an after-commit link dotted', async () => {
    const lines = eventMapMermaid(await project(fixtureManifest(), appFolder)).split('\n');
    expect(lines[0]).toBe('flowchart LR');
    expect(lines).toContain('  command_place_order -- "writes" --> event_OrderPlaced');
    expect(lines).toContain('  event_OrderPlaced -. "starts: after commit" .-> workflow_checkout_1');
    expect(lines).toContain('  event_OrderPlaced -- "starts: same transaction" --> workflow_reserve_stock_1');
    expect(lines).toContain('  workflow_checkout_1 -- "runs: undo, charge" --> command_refund_payment');
    expect(lines).toContain('  event_PaymentSettled -- "waits-for: confirm, as settled" --> workflow_checkout_1');
  });
});

/** A scan root with real files, one per case. */
async function sandbox(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'event-map-'));
  sandboxes.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

const aCommand = (name: string) =>
  `export const ${name} = { name: '${name}', input: {}, writes: [Object.assign(() => null, { type: 'Done' })], handler() { return null; } };`;

describe('scanEntrypoints({ root })', () => {
  // Why: a test file in an entrypoints folder imports commands to call them directly; counting it would
  // make a test look like an entry to the app.
  it('reads files under an entrypoints folder only, and skips tests and declaration files', async () => {
    const root = await sandbox({
      'shop/usecases/a.mjs': aCommand('a'),
      'shop/entrypoints/rpc.mjs': "import { a } from '../usecases/a.mjs';\nexport const x = a;",
      'shop/entrypoints/rpc.test.mjs': "import { a } from '../usecases/a.mjs';\nexport const y = a;",
      'shop/entrypoints/types.d.ts': "import { a } from '../usecases/a.mjs';",
      'shop/usecases/not-an-entrypoint.mjs': "import { a } from './a.mjs';",
    });
    const scan = await scanEntrypoints({ root });
    expect(scan.entries.map(entry => entry.file)).toEqual(['shop/entrypoints/rpc.mjs']);
    expect(scan.entries[0]).toEqual({
      feature: 'shop',
      file: 'shop/entrypoints/rpc.mjs',
      commands: [{ name: 'a', writes: ['Done'] }],
    });
  });

  it('keeps the names an import lists, every export for a namespace import, and nothing for import type', async () => {
    const root = await sandbox({
      'shop/usecases/two.mjs': `${aCommand('one')}\n${aCommand('two')}`,
      'shop/entrypoints/named.mjs': "import { one as renamed } from '../usecases/two.mjs';\nexport const x = renamed;",
      'shop/entrypoints/all.mjs': "import * as all from '../usecases/two.mjs';\nexport const x = all;",
      'shop/entrypoints/typed.ts': "import type { one } from '../usecases/two.mjs';\nexport type X = typeof one;",
    });
    const scan = await scanEntrypoints({ root });
    const named = (file: string) => scan.entries.find(entry => entry.file === file)?.commands.map(command => command.name);
    expect(named('shop/entrypoints/named.mjs')).toEqual(['one']);
    expect(named('shop/entrypoints/all.mjs')).toEqual(['one', 'two']);
    expect(named('shop/entrypoints/typed.ts')).toEqual([]);
  });

  // Why: the scan decides by shape. A value that has a name and a handler but no event list, or an event list of
  // plain strings, is not a journal command, and drawing it would invent an edge.
  it('keeps only values with a name, a list of event definitions and a handler', async () => {
    const root = await sandbox({
      'shop/usecases/values.mjs': [
        aCommand('real'),
        "export const noHandler = { name: 'noHandler', writes: [] };",
        "export const stringWrites = { name: 'stringWrites', writes: ['Done'], handler() {} };",
        "export const config = { name: 'config', retries: 3 };",
        'export const answer = 42;',
      ].join('\n'),
      'shop/entrypoints/rpc.mjs': "import * as values from '../usecases/values.mjs';\nexport const x = values;",
    });
    const scan = await scanEntrypoints({ root });
    expect(scan.entries[0]?.commands.map(command => command.name)).toEqual(['real']);
  });

  it('reports an import that does not resolve, and a module that fails to import, and goes on', async () => {
    const root = await sandbox({
      'shop/usecases/a.mjs': aCommand('a'),
      'shop/usecases/broken.mjs': "throw new Error('needs a database');",
      'shop/entrypoints/rpc.mjs': [
        "import { a } from '../usecases/a.mjs';",
        "import { gone } from '../usecases/gone.mjs';",
        "import { b } from '../usecases/broken.mjs';",
        'export const x = [a, gone, b];',
      ].join('\n'),
    });
    const scan = await scanEntrypoints({ root });
    expect(scan.entries[0]?.commands.map(command => command.name)).toEqual(['a']);
    expect(scan.problems).toEqual([
      { file: 'shop/entrypoints/rpc.mjs', reason: 'import "../usecases/gone.mjs" does not resolve to a file' },
      {
        file: 'shop/entrypoints/rpc.mjs',
        reason: expect.stringMatching(/^import "..\/usecases\/broken.mjs": cannot import: .*needs a database/),
      },
    ]);
  });

  // Why: this is the documented limit. An import is an edge even when the code never calls the command.
  it('draws an edge for a command that is imported and never called', async () => {
    const root = await sandbox({
      'shop/usecases/a.mjs': aCommand('a'),
      'shop/entrypoints/rpc.mjs': "import { a } from '../usecases/a.mjs';\n// a is never used\nexport const x = 1;",
    });
    const scan = await scanEntrypoints({ root });
    expect(scan.entries[0]?.commands).toEqual([{ name: 'a', writes: ['Done'] }]);
  });
});

describe('checkEventMapFile({ file, mermaid, update })', () => {
  it('says missing, then writes when told to, then says fresh, then shows the diff when the text changes', async () => {
    const folder = await sandbox({});
    const file = path.join(folder, 'docs/event-map.mmd');
    const before = 'flowchart LR\n  a --> b\n';
    expect(await checkEventMapFile({ file, mermaid: before })).toMatchObject({ state: 'missing' });
    expect(await checkEventMapFile({ file, mermaid: before, update: true })).toEqual({ state: 'written' });
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await checkEventMapFile({ file, mermaid: before })).toEqual({ state: 'fresh' });
    expect(await checkEventMapFile({ file, mermaid: 'flowchart LR\n  a --> c\n' })).toEqual({
      state: 'stale',
      diff: '-   a --> b\n+   a --> c',
    });
  });
});
