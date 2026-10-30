/**
 * The Mermaid view of the event map: a pure function from the graph to `flowchart LR` text.
 * The order of nodes and edges depends only on the graph's content, never on the order it was built
 * in, so a file kept in an app's docs changes only when the app's events, commands or handlers do.
 * `projection.ts` re-exports it as `eventMapMermaid`.
 */
import { flowOf } from './event-map-flow.js';
import type { EventMapDocument, EventMapEdge, EventMapEdgeKind, EventMapNode, EventMapNodeKind } from './projection.js';

const NODE_ORDER: Readonly<Record<EventMapNodeKind, number>> = {
  entrypoint: 0,
  command: 1,
  event: 2,
  entity: 3,
  projection: 4,
  effect: 5,
  tap: 6,
  workflow: 7,
  feature: 8,
};

const EDGE_ORDER: Readonly<Record<EventMapEdgeKind, number>> = {
  calls: 0,
  writes: 1,
  folds: 2,
  projects: 3,
  reacts: 4,
  'waits-for': 5,
  runs: 6,
  'owned-by': 7,
};

const quoted = (text: string): string => `"${text.replaceAll('"', '#quot;')}"`;

/** The node's shape and words. A feature has no shape: the owner edges are left out of the picture. */
function shape(node: EventMapNode, id: string): string {
  if (node.kind === 'event') return `${id}([${quoted(node.name)}])`;
  if (node.kind === 'entity') return `${id}[(${quoted(`entity ${node.name}`)})]`;
  if (node.kind === 'projection') return `${id}[[${quoted(`projection ${node.name}`)}]]`;
  if (node.kind === 'effect') return `${id}{{${quoted(`effect ${node.name}`)}}}`;
  if (node.kind === 'tap') return `${id}{{${quoted(`tap ${node.name}`)}}}`;
  if (node.kind === 'workflow') return `${id}[/${quoted(`workflow ${node.name}@${node.version}`)}/]`;
  if (node.kind === 'command') return `${id}[${quoted(`command ${node.name}`)}]`;
  if (node.kind === 'entrypoint') return `${id}>${quoted(`${node.feature}: ${node.file}`)}]`;
  return `${id}[${quoted(node.name)}]`;
}

/** What an edge says on the picture. */
function words(edge: EventMapEdge, from: EventMapNode | undefined): string {
  const verb = edge.kind === 'reacts' && from?.kind === 'workflow' ? 'starts' : edge.kind;
  const detail = [
    edge.undo === true ? 'undo' : undefined,
    edge.node,
    edge.label === undefined ? undefined : `as ${edge.label}`,
    edge.timing === 'same-transaction' ? 'same transaction' : edge.timing === 'after-commit' ? 'after commit' : undefined,
  ].filter(part => part !== undefined);
  return detail.length === 0 ? verb : `${verb}: ${detail.join(', ')}`;
}

/**
 * The event map as Mermaid `flowchart LR` text, ending in a newline. Arrows follow the data: command to event,
 * event to its consumers, workflow to the commands it runs. An after-commit link is dotted, a same-transaction
 * or direct link is solid. `owned-by` edges and feature nodes are left out; the text view names owners.
 */
export function eventMapMermaid(document: Pick<EventMapDocument, 'nodes' | 'edges'>): string {
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  const shown = [...document.nodes]
    .filter(node => node.kind !== 'feature')
    .sort((a, b) => NODE_ORDER[a.kind] - NODE_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const node of shown) {
    const base = node.id.replaceAll(/[^a-z0-9]/gi, '_');
    let candidate = base;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${base}_${n}`;
    taken.add(candidate);
    ids.set(node.id, candidate);
  }
  const lines = ['flowchart LR'];
  for (const node of shown) lines.push(`  ${shape(node, ids.get(node.id) ?? node.id)}`);
  const drawn = [...document.edges]
    .filter(edge => edge.kind !== 'owned-by' && ids.has(edge.from) && ids.has(edge.to))
    .map(edge => {
      const { source, target } = flowOf(edge);
      return { edge, tail: ids.get(source) ?? source, head: ids.get(target) ?? target };
    })
    .sort((a, b) => {
      const key = (x: typeof a): string =>
        [String(EDGE_ORDER[x.edge.kind]), x.tail, x.head, x.edge.node ?? '', x.edge.label ?? '', x.edge.undo === true ? '1' : '0'].join('\u0000');
      return key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    });
  for (const { edge, tail, head } of drawn) {
    const text = quoted(words(edge, byId.get(edge.from)));
    lines.push(edge.timing === 'after-commit' ? `  ${tail} -. ${text} .-> ${head}` : `  ${tail} -- ${text} --> ${head}`);
  }
  return `${lines.join('\n')}\n`;
}
