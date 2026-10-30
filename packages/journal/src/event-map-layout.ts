/**
 * The layout of the event map page: a pure function from the graph to boxes and curves, so a test can check
 * that every node and edge of `dot explain --as event-map` is on the page without a browser.
 *
 * Columns, left to right: entrypoints, commands, events, then everything that consumes an event (entity folds,
 * projections, effects, taps, workflows). Feature nodes are the owners shown in the details and the filter; they get no box.
 * An edge is drawn in the direction data flows (`flowOf`): command to event, event to its consumers, workflow to the
 * command it runs, so a workflow's `runs` curve goes back to the left.
 */
import { flowOf } from './event-map-flow.js';
import type { EventMapDocument, EventMapEdge, EventMapNode, EventMapNodeKind } from './projection.js';

export const COLUMN_WIDTH = 215;
export const NODE_WIDTH = 170;
export const NODE_HEIGHT = 46;
export const ROW_GAP = 14;
export const MARGIN_LEFT = 16;
export const MARGIN_TOP = 40;

/** The column titles, left to right. */
export const COLUMN_TITLES = ['Entrypoints', 'Commands', 'Events', 'Reactions, workflows'] as const;

const COLUMN_OF: Readonly<Record<Exclude<EventMapNodeKind, 'feature'>, number>> = {
  entrypoint: 0,
  command: 1,
  event: 2,
  entity: 3,
  projection: 3,
  effect: 3,
  tap: 3,
  workflow: 3,
};

export type PlacedNode = {
  readonly node: EventMapNode;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  /** True in a feature's view when the node belongs to another feature and is drawn for context only. */
  readonly context: boolean;
};

/** `source` and `target` are node ids in the direction data flows; the curve ends at `target`. */
export type PlacedEdge = {
  readonly edge: EventMapEdge;
  readonly index: number;
  readonly source: string;
  readonly target: string;
  readonly path: string;
};

export type Layout = {
  readonly width: number;
  readonly height: number;
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly PlacedEdge[];
};

/** The feature that owns a node: the `owned-by` edge, or an entrypoint's own `feature`. */
export function ownersOf(document: EventMapDocument): ReadonlyMap<string, string> {
  const names = new Map(document.nodes.map(node => [node.id, node.name]));
  const owners = new Map<string, string>();
  for (const node of document.nodes) if (node.kind === 'entrypoint') owners.set(node.id, node.feature);
  for (const edge of document.edges) {
    const feature = names.get(edge.to);
    if (edge.kind === 'owned-by' && feature !== undefined) owners.set(edge.from, feature);
  }
  return owners;
}

/** The feature names with something to show, sorted. */
export function featuresOf(document: EventMapDocument): string[] {
  return [...new Set([...ownersOf(document).values()])].toSorted();
}

const columnOf = (node: EventMapNode): number | undefined => (node.kind === 'feature' ? undefined : COLUMN_OF[node.kind]);

/** A smooth curve from the side of `from` that faces `to`. */
function pathBetween(from: PlacedNode, to: PlacedNode): string {
  const backward = from.column > to.column;
  const startX = backward ? from.x : from.x + NODE_WIDTH;
  const endX = backward ? to.x + NODE_WIDTH : to.x;
  const startY = from.y + NODE_HEIGHT / 2;
  const endY = to.y + NODE_HEIGHT / 2;
  const half = (endX - startX) / 2;
  return `M${startX} ${startY}C${startX + half} ${startY} ${endX - half} ${endY} ${endX} ${endY}`;
}

/**
 * Lay out the graph. With `feature`, only that feature's nodes and the nodes they share an edge with are placed;
 * the neighbours are marked `context`. Rows are ordered by the average row of the neighbours in the column to the
 * left, which keeps most edges from crossing; ties break on the name.
 */
export function layoutEventMap(document: EventMapDocument, feature?: string): Layout {
  const owners = ownersOf(document);
  const drawable = document.nodes.filter(node => columnOf(node) !== undefined);
  const owned = (node: EventMapNode): boolean => feature === undefined || owners.get(node.id) === feature;
  const keep = new Set(drawable.filter(owned).map(node => node.id));
  const neighbours = new Set<string>();
  if (feature !== undefined)
    for (const edge of document.edges) {
      if (keep.has(edge.from)) neighbours.add(edge.to);
      if (keep.has(edge.to)) neighbours.add(edge.from);
    }
  const shown = drawable.filter(node => keep.has(node.id) || neighbours.has(node.id));
  const shownIds = new Set(shown.map(node => node.id));
  const edges = document.edges
    .map((edge, index) => ({ edge, index }))
    .filter(({ edge }) => edge.kind !== 'owned-by' && shownIds.has(edge.from) && shownIds.has(edge.to));

  const columns: EventMapNode[][] = COLUMN_TITLES.map(() => []);
  for (const node of shown) columns[columnOf(node) ?? 0]?.push(node);
  const rowOf = new Map<string, number>();
  const setRows = (column: EventMapNode[]): void => column.forEach((node, row) => rowOf.set(node.id, row));
  const byName = (a: EventMapNode, b: EventMapNode): number => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const average = (node: EventMapNode, fixed: ReadonlySet<string>): number => {
    const rows = edges.flatMap(({ edge }) => {
      const other = edge.from === node.id ? edge.to : edge.to === node.id ? edge.from : undefined;
      return other !== undefined && fixed.has(other) ? [rowOf.get(other) ?? 0] : [];
    });
    return rows.length === 0 ? Number.POSITIVE_INFINITY : rows.reduce((sum, row) => sum + row, 0) / rows.length;
  };
  // The events set the order; every other column follows the nearest placed column.
  columns[2]?.sort(byName);
  setRows(columns[2] ?? []);
  const eventIds = new Set((columns[2] ?? []).map(node => node.id));
  columns[3]?.sort((a, b) => average(a, eventIds) - average(b, eventIds) || byName(a, b));
  setRows(columns[3] ?? []);
  columns[1]?.sort((a, b) => average(a, eventIds) - average(b, eventIds) || byName(a, b));
  setRows(columns[1] ?? []);
  const commandIds = new Set((columns[1] ?? []).map(node => node.id));
  columns[0]?.sort((a, b) => average(a, commandIds) - average(b, commandIds) || byName(a, b));
  setRows(columns[0] ?? []);

  const placed = new Map<string, PlacedNode>();
  columns.forEach((column, columnIndex) => {
    column.forEach((node, row) => {
      placed.set(node.id, {
        node,
        column: columnIndex,
        x: MARGIN_LEFT + columnIndex * COLUMN_WIDTH,
        y: MARGIN_TOP + row * (NODE_HEIGHT + ROW_GAP),
        context: !keep.has(node.id),
      });
    });
  });
  const placedEdges = edges.flatMap(({ edge, index }) => {
    const { source, target } = flowOf(edge);
    const from = placed.get(source);
    const to = placed.get(target);
    return from === undefined || to === undefined ? [] : [{ edge, index, source, target, path: pathBetween(from, to) }];
  });
  const rows = Math.max(1, ...columns.map(column => column.length));
  return {
    width: MARGIN_LEFT * 2 + (COLUMN_TITLES.length - 1) * COLUMN_WIDTH + NODE_WIDTH,
    height: MARGIN_TOP + rows * (NODE_HEIGHT + ROW_GAP),
    nodes: [...placed.values()],
    edges: placedEdges,
  };
}
