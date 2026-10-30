/**
 * `dot explain --as journal-flow`: the app's event graph.
 *
 * Nothing new is collected for it. When the app is configured, `journal({ j })` reads every
 * feature's declarations (the entities its handlers name, its projections, its effects, taps
 * and workflows) and puts the graph in the meta of the projection it registers. This module
 * only reads that meta back from the manifest. The reactive part of an app ("placing an order
 * sends a receipt") is otherwise invisible: no import and no call connects the command to the effect.
 *
 * The document is one graph for the whole app: typed nodes and typed edges. Each edge reads
 * subject, verb, object: `entity folds event`, `projection projects event`, `effect reacts to
 * event`, `effect owned-by feature`. `render(document)` prints it per event, for a reader.
 *
 * Loaded by the Dot CLI from the app's manifest; it imports neither Dot nor the journal, so it
 * runs without booting anything.
 */
import { is } from '@arki/schema';

import type { Projection } from './types.js';

import { journalFlowGraphSchema } from './journal-flow-schema.js';

import type { JOURNAL_FLOW_DELIVERIES, JOURNAL_FLOW_EDGE_KINDS, JOURNAL_FLOW_TIMINGS } from './journal-flow-kinds.js';

export { JOURNAL_FLOW_DELIVERIES, JOURNAL_FLOW_EDGE_KINDS, JOURNAL_FLOW_TIMINGS } from './journal-flow-kinds.js';

export type JournalFlowTiming = (typeof JOURNAL_FLOW_TIMINGS)[number];
export type JournalFlowDelivery = (typeof JOURNAL_FLOW_DELIVERIES)[number];

/** An effect's retry policy: the journal's default, or its own `schedule.retry`. `maxRetries` is `null` for no limit. */
export type JournalFlowRetry = { readonly policy: 'default' | 'custom'; readonly maxRetries: number | null };

/** One node. `id` is `<kind>:<name>` (`effect:send-receipt`, `workflow:refund@1`). */
export type JournalFlowNode =
  | { readonly id: string; readonly kind: 'event'; readonly name: string }
  | { readonly id: string; readonly kind: 'entity'; readonly name: string; readonly table: string }
  | { readonly id: string; readonly kind: 'projection'; readonly name: string; readonly lane: Projection['lane'] }
  | {
      readonly id: string;
      readonly kind: 'effect';
      readonly name: string;
      /** The deps the effect picked from its feature (`needsOf((_: Deps) => ['mailer'])`). */
      readonly deps: string[];
      readonly retry: JournalFlowRetry;
    }
  | { readonly id: string; readonly kind: 'tap'; readonly name: string; readonly deps: string[] }
  | {
      readonly id: string;
      readonly kind: 'workflow';
      readonly name: string;
      readonly version: number;
      readonly deps: string[];
      readonly signals: string[];
    }
  | { readonly id: string; readonly kind: 'feature'; readonly name: string };

/** One edge, subject to object. `timing` and `delivery` are set on edges to an event only. */
export type JournalFlowEdge = {
  readonly kind: (typeof JOURNAL_FLOW_EDGE_KINDS)[number];
  readonly from: string;
  readonly to: string;
  readonly timing?: JournalFlowTiming;
  readonly delivery?: JournalFlowDelivery;
};

/** The graph `journal({ j })` derives from the features' declarations. */
/** Plain arrays, as the manifest's JSON types them: the graph travels in a projection's `meta`. */
export type JournalFlowGraph = { readonly nodes: JournalFlowNode[]; readonly edges: JournalFlowEdge[] };

/** `dot explain --as journal-flow --json`: the whole app's graph. */
export type JournalFlowDocument = JournalFlowGraph & { readonly format: 'journal-flow' };

type ManifestLike = {
  readonly projections: readonly { readonly format: string; readonly module: string; readonly meta?: unknown }[];
};

/**
 * The app's event graph, merged from every journal the app mounts (a renamed second journal adds
 * its own). A node is listed once; an edge once.
 */
export function project(manifest: ManifestLike): JournalFlowDocument {
  const nodes = new Map<string, JournalFlowNode>();
  const edges = new Map<string, JournalFlowEdge>();
  for (const registered of manifest.projections) {
    if (registered.format !== 'journal-flow' || !is(registered.meta, journalFlowGraphSchema)) continue;
    for (const node of registered.meta.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const edge of registered.meta.edges) edges.set(`${edge.kind} ${edge.from} ${edge.to}`, edge);
  }
  return { format: 'journal-flow', nodes: [...nodes.values()], edges: [...edges.values()] };
}

const TIMING_TEXT: Readonly<Record<JournalFlowTiming, string>> = {
  'same-transaction': 'same transaction',
  'after-commit': 'after commit',
};

function whenText(edge: JournalFlowEdge): string {
  const timing = edge.timing === undefined ? '' : TIMING_TEXT[edge.timing];
  return edge.delivery === undefined ? timing : `${timing}, ${edge.delivery.replaceAll('-', ' ')}`;
}

function retryText(retry: JournalFlowRetry): string {
  const tries = retry.maxRetries === null ? 'no limit' : `${retry.maxRetries} retries`;
  return `retry ${retry.policy}, ${tries}`;
}

/** A node as the text names it: a workflow with its version. */
const nameOf = (node: JournalFlowNode): string => (node.kind === 'workflow' ? `${node.name}@${node.version}` : node.name);

/** The detail after a node's name: its owner, its deps, its retry policy. */
function detailOf(node: JournalFlowNode, owner: string | undefined): string {
  const parts = owner === undefined ? [] : [`owner ${owner}`];
  if (node.kind === 'effect' || node.kind === 'tap' || node.kind === 'workflow')
    parts.push(node.deps.length === 0 ? 'deps none' : `deps ${node.deps.join(', ')}`);
  if (node.kind === 'effect') parts.push(retryText(node.retry));
  if (node.kind === 'tap') parts.push('no retry');
  if (node.kind === 'workflow') parts.push('retry per step');
  return parts.join('; ');
}

/** The reading order of an event's consumers: its fold, its projections, then the reactions. */
const ORDER: Readonly<Record<JournalFlowNode['kind'], number>> = {
  entity: 0,
  projection: 1,
  effect: 2,
  tap: 3,
  workflow: 4,
  event: 5,
  feature: 5,
};

const LABEL: Readonly<Record<JournalFlowNode['kind'], string>> = {
  entity: 'fold',
  projection: 'projection',
  effect: 'effect',
  tap: 'tap',
  workflow: 'workflow',
  event: 'event',
  feature: 'feature',
};

/** `dot explain --as journal-flow`: the graph per event, each consumer with its timing, owner, deps and retry. */
export function render(document: unknown): string {
  if (!is(document, journalFlowGraphSchema)) return 'journal-flow: the document is not a journal-flow graph.';
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  const ownerOf = new Map<string, string>();
  for (const edge of document.edges) {
    const feature = byId.get(edge.to);
    if (edge.kind === 'owned-by' && feature !== undefined) ownerOf.set(edge.from, feature.name);
  }
  const lines: string[] = [];
  for (const event of document.nodes) {
    if (event.kind !== 'event') continue;
    const consumers = document.edges
      .filter(edge => edge.to === event.id && edge.kind !== 'owned-by')
      .flatMap(edge => {
        const node = byId.get(edge.from);
        return node === undefined ? [] : [{ edge, node }];
      })
      .sort((a, b) => ORDER[a.node.kind] - ORDER[b.node.kind]);
    lines.push(lines.length === 0 ? event.name : `\n${event.name}`);
    if (consumers.length === 0) lines.push('  (no consumer)');
    for (const { edge, node } of consumers) {
      const detail = detailOf(node, ownerOf.get(node.id));
      lines.push(`  ${LABEL[node.kind]} ${nameOf(node)}  [${whenText(edge)}]${detail === '' ? '' : `  ${detail}`}`);
    }
  }
  // A workflow without `startOn` is started by a command, not by an event: listed once, at the end.
  const reacting = new Set(document.edges.filter(edge => edge.kind === 'reacts').map(edge => edge.from));
  const unstarted = document.nodes.filter(
    node => (node.kind === 'effect' || node.kind === 'tap' || node.kind === 'workflow') && !reacting.has(node.id),
  );
  if (unstarted.length > 0) lines.push(lines.length === 0 ? 'Started by no event' : '\nStarted by no event');
  for (const node of unstarted) lines.push(`  ${LABEL[node.kind]} ${nameOf(node)}  ${detailOf(node, ownerOf.get(node.id))}`);
  return lines.length === 0 ? 'journal-flow: no events.' : lines.join('\n');
}
