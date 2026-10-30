/**
 * `dot explain --as event-map`: the app's event map.
 *
 * Nothing new is collected for it. When the app is configured, `journal({ j })` reads every
 * feature's declarations (the entities its handlers name, its projections, its effects, taps
 * and workflows with their command nodes and event waits) and puts the graph in the meta of the
 * projection it registers. The commands that procedures call are not declared anywhere (a procedure
 * imports the command and calls `context.run`), so the Node-only `@arki/journal/event-map` entry scans
 * the procedure files and adds them. This module is the part that needs no filesystem: the types, the
 * merge of a scan into the graph, and the text view. The Mermaid view is `eventMapMermaid`.
 *
 * The document is one graph for the whole app: typed nodes and typed edges. Each edge reads
 * subject, verb, object: `command writes event`, `entity folds event`, `projection projects event`,
 * `effect reacts to event`, `workflow waits-for event`, `workflow runs command`, `entrypoint calls
 * command`, `effect owned-by feature`. `render(document)` prints it per event, for a reader.
 *
 * It imports neither Dot nor the journal, so it runs without booting anything.
 */
import { is } from '@arki/schema';

import type { Projection } from './types.js';

import { eventMapDocumentSchema, eventMapMetaSchema } from './event-map-schema.js';

import type {
  EVENT_MAP_DELIVERIES,
  EVENT_MAP_EDGE_KINDS,
  EVENT_MAP_NODE_KINDS,
  EVENT_MAP_TIMINGS,
} from './event-map-kinds.js';

export {
  EVENT_MAP_DELIVERIES,
  EVENT_MAP_EDGE_KINDS,
  EVENT_MAP_NODE_KINDS,
  EVENT_MAP_TIMINGS,
} from './event-map-kinds.js';
export { eventMapMermaid } from './event-map-mermaid.js';

export type EventMapTiming = (typeof EVENT_MAP_TIMINGS)[number];
export type EventMapDelivery = (typeof EVENT_MAP_DELIVERIES)[number];
export type EventMapNodeKind = (typeof EVENT_MAP_NODE_KINDS)[number];
export type EventMapEdgeKind = (typeof EVENT_MAP_EDGE_KINDS)[number];

/** An effect's retry policy: the journal's default, or its own `schedule.retry`. `maxRetries` is `null` for no limit. */
export type EventMapRetry = { readonly policy: 'default' | 'custom'; readonly maxRetries: number | null };

/** One node. `id` is `<kind>:<name>` (`effect:send-receipt`, `workflow:refund@1`). */
export type EventMapNode =
  | { readonly id: string; readonly kind: 'event'; readonly name: string }
  | { readonly id: string; readonly kind: 'entity'; readonly name: string; readonly table: string }
  | { readonly id: string; readonly kind: 'projection'; readonly name: string; readonly lane: Projection['lane'] }
  | {
      readonly id: string;
      readonly kind: 'effect';
      readonly name: string;
      /** The deps the effect picked from its feature (`needsOf((_: Deps) => ['mailer'])`). */
      readonly deps: string[];
      readonly retry: EventMapRetry;
    }
  | { readonly id: string; readonly kind: 'tap'; readonly name: string; readonly deps: string[] }
  | {
      readonly id: string;
      readonly kind: 'workflow';
      readonly name: string;
      readonly version: number;
      readonly deps: string[];
      readonly signals: string[];
      /**
       * The `.step` nodes, by name. A step body may call `ctx.run`, and the map cannot see inside it, so no
       * edge is drawn for such a call. A command that must show on the map belongs in a `.command` node.
       */
      readonly opaqueSteps: string[];
    }
  | { readonly id: string; readonly kind: 'feature'; readonly name: string }
  /** A `j.command`. `name` is the command's name; the events it writes are its `writes` edges. */
  | { readonly id: string; readonly kind: 'command'; readonly name: string }
  /** One procedure file the scan read. `name` and `file` are the path under the scan root; `feature` owns the file. */
  | {
      readonly id: string;
      readonly kind: 'entrypoint';
      readonly name: string;
      readonly feature: string;
      readonly file: string;
    };

/**
 * One edge, subject to object. `timing` and `delivery` are set on edges to an event only. On a workflow edge,
 * `node` is the workflow node it comes from (a branch node is `parallel.branch.node`), `label` is the name of an
 * event wait's source, and `undo` is `true` when the command is the node's `undo`.
 */
export type EventMapEdge = {
  readonly kind: EventMapEdgeKind;
  readonly from: string;
  readonly to: string;
  readonly timing?: EventMapTiming;
  readonly delivery?: EventMapDelivery;
  readonly node?: string;
  readonly label?: string;
  readonly undo?: true;
};

/** The graph `journal({ j })` derives from the features' declarations. */
/** Plain arrays, as the manifest's JSON types them: the graph travels in a projection's `meta`. */
export type EventMapGraph = { readonly nodes: EventMapNode[]; readonly edges: EventMapEdge[] };

/** What `journal({ j })` registers in the manifest: the graph, and the folder the entrypoint scan reads. */
export type EventMapMeta = EventMapGraph & { readonly entrypointRoot: string };

/** A procedure file the scan could not read, and why. The map is drawn without it. */
export type EventMapProblem = { readonly file: string; readonly reason: string };

/** `dot explain --as event-map --json`: the whole app's graph. */
export type EventMapDocument = EventMapGraph & {
  readonly format: 'event-map';
  readonly problems: EventMapProblem[];
};

/** One procedure file with the journal commands it imports. `file` is the path under the scan root. */
export type EventMapScanEntry = {
  readonly feature: string;
  readonly file: string;
  readonly commands: readonly { readonly name: string; readonly writes: readonly string[] }[];
};

/** The key that makes an edge unique: two edges of one kind between the same nodes differ by node, label or undo. */
export const edgeKey = (edge: EventMapEdge): string =>
  [edge.kind, edge.from, edge.to, edge.node ?? '', edge.label ?? '', edge.undo === true ? 'undo' : ''].join(' ');

type ManifestLike = {
  readonly projections: readonly { readonly format: string; readonly module: string; readonly meta?: unknown }[];
};

/**
 * The app's graph, merged from every journal the app mounts (a renamed second journal adds its own),
 * without the entrypoint scan. A node is listed once; an edge once. `entrypointRoot` is the folder
 * the scan reads: the first journal's.
 */
export function projectGraph(manifest: ManifestLike): {
  readonly document: EventMapDocument;
  readonly entrypointRoot: string | undefined;
} {
  const nodes = new Map<string, EventMapNode>();
  const edges = new Map<string, EventMapEdge>();
  let entrypointRoot: string | undefined;
  for (const registered of manifest.projections) {
    if (registered.format !== 'event-map' || !is(registered.meta, eventMapMetaSchema)) continue;
    entrypointRoot ??= registered.meta.entrypointRoot;
    for (const node of registered.meta.nodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
    for (const edge of registered.meta.edges) edges.set(edgeKey(edge), edge);
  }
  return {
    document: { format: 'event-map', nodes: [...nodes.values()], edges: [...edges.values()], problems: [] },
    entrypointRoot,
  };
}

/**
 * The graph with a scan's findings added: an `entrypoint` node per file, a `command` node per command it
 * imports (once), the command's `writes` edges, and an `entrypoint calls command` edge. A command that
 * is imported and never called still gets its edge: the scan reads imports, not calls.
 */
export function withEntrypoints(
  document: EventMapDocument,
  scanned: readonly EventMapScanEntry[],
  problems: readonly EventMapProblem[],
): EventMapDocument {
  const nodes = new Map(document.nodes.map(node => [node.id, node]));
  const edges = new Map(document.edges.map(edge => [edgeKey(edge), edge]));
  const addNode = (node: EventMapNode): string => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    return node.id;
  };
  const addEdge = (edge: EventMapEdge): void => void edges.set(edgeKey(edge), edge);
  for (const entry of scanned) {
    const entrypoint = addNode({
      id: `entrypoint:${entry.file}`,
      kind: 'entrypoint',
      name: entry.file,
      feature: entry.feature,
      file: entry.file,
    });
    for (const command of entry.commands) {
      const commandId = addNode({ id: `command:${command.name}`, kind: 'command', name: command.name });
      for (const type of command.writes)
        addEdge({ kind: 'writes', from: commandId, to: addNode({ id: `event:${type}`, kind: 'event', name: type }) });
      addEdge({ kind: 'calls', from: entrypoint, to: commandId });
    }
  }
  return { ...document, nodes: [...nodes.values()], edges: [...edges.values()], problems: [...problems] };
}

const TIMING_TEXT: Readonly<Record<EventMapTiming, string>> = {
  'same-transaction': 'same transaction',
  'after-commit': 'after commit',
};

function whenText(edge: EventMapEdge): string {
  const timing = edge.timing === undefined ? '' : TIMING_TEXT[edge.timing];
  return edge.delivery === undefined ? timing : `${timing}, ${edge.delivery.replaceAll('-', ' ')}`;
}

function retryText(retry: EventMapRetry): string {
  const tries = retry.maxRetries === null ? 'no limit' : `${retry.maxRetries} retries`;
  return `retry ${retry.policy}, ${tries}`;
}

/** A node as the text names it: a workflow with its version. */
const nameOf = (node: EventMapNode): string => (node.kind === 'workflow' ? `${node.name}@${node.version}` : node.name);

/** The detail after a node's name: its owner, its deps, its retry policy. */
function detailOf(node: EventMapNode, owner: string | undefined): string {
  const parts = owner === undefined ? [] : [`owner ${owner}`];
  if (node.kind === 'effect' || node.kind === 'tap' || node.kind === 'workflow')
    parts.push(node.deps.length === 0 ? 'deps none' : `deps ${node.deps.join(', ')}`);
  if (node.kind === 'effect') parts.push(retryText(node.retry));
  if (node.kind === 'tap') parts.push('no retry');
  if (node.kind === 'workflow') parts.push('retry per step');
  return parts.join('; ');
}

/** The reading order of an event's consumers: its fold, its projections, then the reactions. */
const ORDER: Readonly<Record<EventMapNodeKind, number>> = {
  entity: 0,
  projection: 1,
  effect: 2,
  tap: 3,
  workflow: 4,
  event: 5,
  feature: 5,
  command: 5,
  entrypoint: 5,
};

const LABEL: Readonly<Record<EventMapNodeKind, string>> = {
  entity: 'fold',
  projection: 'projection',
  effect: 'effect',
  tap: 'tap',
  workflow: 'workflow',
  event: 'event',
  feature: 'feature',
  command: 'command',
  entrypoint: 'entrypoint',
};

/** What a workflow edge to an event says in the text, after the workflow's name. */
function workflowEdgeText(edge: EventMapEdge, from: EventMapNode): string {
  if (edge.kind === 'waits-for') return `waits as "${edge.label ?? ''}" at node ${edge.node ?? ''}`;
  return edge.kind === 'reacts' && from.kind === 'workflow' ? 'starts' : '';
}

/**
 * `dot explain --as event-map`: the graph per event, each writer and consumer with its timing, owner, deps
 * and retry; then each workflow's nodes, each entrypoint's commands, and the procedure files the scan could not read.
 */
export function render(document: unknown): string {
  if (!is(document, eventMapDocumentSchema)) return 'event-map: the document is not an event-map graph.';
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  const ownerOf = new Map<string, string>();
  for (const edge of document.edges) {
    const feature = byId.get(edge.to);
    if (edge.kind === 'owned-by' && feature !== undefined) ownerOf.set(edge.from, feature.name);
  }
  const lines: string[] = [];
  const block = (head: string): void => void lines.push(lines.length === 0 ? head : `\n${head}`);
  /** Where a command is reached from: the procedure files that import it, and the workflow nodes that run it. */
  const reachOf = (commandId: string): string => {
    const reach: string[] = [];
    for (const edge of document.edges) {
      if (edge.to !== commandId) continue;
      const from = byId.get(edge.from);
      if (from?.kind === 'entrypoint') reach.push(`${from.feature}: ${from.file}`);
      if (from?.kind === 'workflow')
        reach.push(`workflow ${nameOf(from)} node ${edge.node ?? ''}${edge.undo === true ? ' (undo)' : ''}`);
    }
    return reach.length === 0 ? 'no entrypoint or workflow found' : reach.join('; ');
  };
  for (const event of document.nodes) {
    if (event.kind !== 'event') continue;
    block(event.name);
    const writers = document.edges.filter(edge => edge.kind === 'writes' && edge.to === event.id);
    for (const edge of writers) {
      const command = byId.get(edge.from);
      if (command !== undefined) lines.push(`  written by command ${command.name}  [${reachOf(command.id)}]`);
    }
    const consumers = document.edges
      .filter(edge => edge.to === event.id && edge.kind !== 'owned-by' && edge.kind !== 'writes')
      .flatMap(edge => {
        const node = byId.get(edge.from);
        return node === undefined ? [] : [{ edge, node }];
      })
      .sort((a, b) => ORDER[a.node.kind] - ORDER[b.node.kind]);
    if (consumers.length === 0 && writers.length === 0) lines.push('  (no consumer)');
    for (const { edge, node } of consumers) {
      const detail = detailOf(node, ownerOf.get(node.id));
      const action = workflowEdgeText(edge, node);
      const when = edge.kind === 'waits-for' ? '' : `  [${whenText(edge)}]`;
      lines.push(
        `  ${LABEL[node.kind]} ${nameOf(node)}${action === '' ? '' : ` ${action}`}${when}${detail === '' ? '' : `  ${detail}`}`,
      );
    }
  }
  for (const workflow of document.nodes) {
    if (workflow.kind !== 'workflow') continue;
    const own = document.edges.filter(
      edge => edge.from === workflow.id && (edge.kind === 'runs' || edge.kind === 'waits-for'),
    );
    if (own.length === 0 && workflow.opaqueSteps.length === 0) continue;
    block(`Workflow ${nameOf(workflow)}`);
    for (const edge of own) {
      const target = byId.get(edge.to);
      if (target === undefined) continue;
      lines.push(
        edge.kind === 'runs'
          ? `  node ${edge.node ?? ''}  ${edge.undo === true ? 'undoes with' : 'runs'} command ${target.name}`
          : `  node ${edge.node ?? ''}  waits for ${target.name} as "${edge.label ?? ''}"`,
      );
    }
    if (workflow.opaqueSteps.length > 0)
      lines.push(`  opaque steps (may run commands, not drawn): ${workflow.opaqueSteps.join(', ')}`);
  }
  if (document.nodes.some(node => node.kind === 'entrypoint')) block('Entrypoints');
  for (const entrypoint of document.nodes) {
    if (entrypoint.kind !== 'entrypoint') continue;
    const called = document.edges
      .filter(edge => edge.kind === 'calls' && edge.from === entrypoint.id)
      .flatMap(edge => byId.get(edge.to)?.name ?? []);
    lines.push(
      `  ${entrypoint.feature}: ${entrypoint.file}  imports ${called.length === 0 ? 'no command' : called.join(', ')}`,
    );
  }
  // A workflow without `startOn` is started by a command, not by an event: listed once, at the end.
  const reacting = new Set(document.edges.filter(edge => edge.kind === 'reacts').map(edge => edge.from));
  const unstarted = document.nodes.filter(
    node => (node.kind === 'effect' || node.kind === 'tap' || node.kind === 'workflow') && !reacting.has(node.id),
  );
  if (unstarted.length > 0) block('Started by no event');
  for (const node of unstarted)
    lines.push(`  ${LABEL[node.kind]} ${nameOf(node)}  ${detailOf(node, ownerOf.get(node.id))}`);
  if (document.problems.length > 0) block('Not scanned');
  for (const problem of document.problems) lines.push(`  ${problem.file}: ${problem.reason}`);
  return lines.length === 0 ? 'event-map: no events.' : lines.join('\n');
}
