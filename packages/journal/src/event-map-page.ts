/**
 * The event map page for the `dot dev` console. Dot calls `consolePage(document)` on this module (the
 * manifest's projection says `console: { title }`) with the same document `dot explain --as event-map`
 * prints, and puts the returned HTML inside the console's shell. There is no second graph builder.
 *
 * The server side draws the SVG (one view of the whole graph and one per feature, laid out by
 * `layoutEventMap`), so every node and edge is in the HTML. The small script only switches the view,
 * marks the selection and its edges, filters by name, and fills the details box. It loads nothing from
 * the network. The page styles itself with the console's CSS variables only.
 */
import { is } from '@arki/schema';

import type { PlacedNode } from './event-map-layout.js';
import type { EventMapDocument } from './projection.js';

import {
  COLUMN_TITLES,
  COLUMN_WIDTH,
  featuresOf,
  layoutEventMap,
  MARGIN_LEFT,
  NODE_HEIGHT,
  NODE_WIDTH,
} from './event-map-layout.js';
import { flowOf } from './event-map-flow.js';
import { eventMapDocumentSchema } from './event-map-schema.js';

const escapeHtml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** JSON that is safe inside a `<script>`: no `</script>`, no line separators. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

const truncated = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

const nameOf = (placed: PlacedNode): string =>
  placed.node.kind === 'workflow' ? `${placed.node.name}@${placed.node.version}` : placed.node.name;

function nodeSvg(placed: PlacedNode): string {
  const { node } = placed;
  const label = nameOf(placed);
  const classes = `node k-${node.kind}${placed.context ? ' context' : ''}`;
  return (
    `<g class="${classes}" data-id="${escapeHtml(node.id)}" transform="translate(${placed.x} ${placed.y})" tabindex="0" role="button" aria-label="${escapeHtml(`${node.kind} ${label}`)}">` +
    `<title>${escapeHtml(`${node.kind} ${label}`)}</title>` +
    `<rect width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="${node.kind === 'event' ? NODE_HEIGHT / 2 : 6}"/>` +
    `<text class="kind" x="12" y="17">${escapeHtml(node.kind)}</text>` +
    `<text class="name" x="12" y="35">${escapeHtml(truncated(label, 20))}</text></g>`
  );
}

/** One SVG: the whole graph (`view` is `""`) or one feature's slice. */
function viewSvg(document: EventMapDocument, feature: string | undefined): string {
  const layout = layoutEventMap(document, feature);
  const headings = COLUMN_TITLES.map(
    (title, column) =>
      `<text class="column" x="${MARGIN_LEFT + column * COLUMN_WIDTH}" y="20">${escapeHtml(title)}</text>`,
  ).join('');
  const markerId = `arrow-${feature ?? 'all'}`;
  const edges = layout.edges
    .map(
      ({ edge, index, source, target, path }) =>
        `<path class="edge e-${edge.kind}" data-index="${index}" data-source="${escapeHtml(source)}" data-target="${escapeHtml(target)}" d="${path}" marker-end="url(#${escapeHtml(markerId)})"><title>${escapeHtml(`${edge.kind}${edge.node === undefined ? '' : ` at ${edge.node}`}`)}</title></path>`,
    )
    .join('');
  const hidden = feature === undefined ? '' : ' hidden';
  return (
    `<svg class="map" data-view="${escapeHtml(feature ?? '')}"${hidden} width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="group" aria-label="Event map${feature === undefined ? '' : `, feature ${escapeHtml(feature)}`}">` +
    `<defs><marker id="${escapeHtml(markerId)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker></defs>` +
    `${headings}${edges}${layout.nodes.map(nodeSvg).join('')}</svg>`
  );
}

const STYLE = `
.em { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); }
.em h1 { font-size: 20px; margin: 0 0 4px; }
.em .lede { color: var(--muted); margin: 0; }
.em .bar { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: end; }
.em label { display: grid; gap: 2px; font-size: 13px; color: var(--muted); }
.em select, .em input { font: inherit; color: var(--fg); background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--radius); padding: 6px 8px; min-height: 36px; }
.em .count { color: var(--muted); font-size: 13px; padding-bottom: 8px; }
.em .stage { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1100px) { .em .stage { grid-template-columns: minmax(0, 1fr) 320px; } }
.em .scroll { overflow: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); max-height: 75vh; }
.em svg.map { display: block; }
.em svg[hidden] { display: none; }
.em .column { fill: var(--muted); font: 12px var(--font); text-transform: uppercase; letter-spacing: .04em; }
.em .node { cursor: pointer; outline: none; }
.em .node rect { fill: var(--surface); stroke: var(--muted); stroke-width: 1.2; }
.em .node.k-entrypoint rect { stroke-dasharray: 4 3; }
.em .node.k-command rect { stroke: var(--accent); }
.em .node.k-workflow rect { stroke-width: 2.4; }
.em .node.k-effect rect, .em .node.k-tap rect { stroke: var(--fg); }
.em .node .kind { fill: var(--muted); font: 11px var(--font); }
.em .node .name { fill: var(--fg); font: 12px var(--mono); }
.em .node.context { opacity: .55; }
.em .node:focus-visible rect { stroke: var(--accent); stroke-width: 3; }
.em .node.selected rect { stroke: var(--accent); stroke-width: 3; fill: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
.em .node.match rect { stroke: var(--ok); stroke-width: 3; }
.em .edge { fill: none; stroke: var(--muted); stroke-width: 1.2; opacity: .75; }
.em .edge.e-waits-for { stroke-dasharray: 6 4; }
.em .edge.e-runs { stroke-dasharray: 2 3; }
.em .edge.e-calls { stroke-width: .9; }
.em .faded { opacity: .15; }
.em .edge.hot { stroke: var(--accent); stroke-width: 2.4; opacity: 1; }
.em .details { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 12px 14px; }
.em .details h2 { font-size: 16px; margin: 0 0 8px; overflow-wrap: anywhere; }
.em .details h3 { font-size: 14px; margin: 14px 0 4px; }
.em .details dl { margin: 0; display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; }
.em .details dt { color: var(--muted); }
.em .details dd { margin: 0; overflow-wrap: anywhere; }
.em .details ul { margin: 0; padding-left: 18px; }
.em .problems { border: 1px solid var(--warn); border-radius: var(--radius); padding: 10px 14px; }
.em .problems h2 { font-size: 15px; margin: 0 0 6px; color: var(--warn); }
.em .problems li { overflow-wrap: anywhere; }
.em .legend { color: var(--muted); font-size: 13px; margin: 0; }
`;

/** The script: view switch, selection, search and details. It reads the page's own embedded document. */
const SCRIPT = `
(function () {
  var root = document.getElementById('event-map');
  var data = JSON.parse(document.getElementById('event-map-data').textContent);
  var byId = {};
  data.nodes.forEach(function (n) { byId[n.id] = n; });
  var owner = {};
  data.edges.forEach(function (e) { if (e.kind === 'owned-by' && byId[e.to]) owner[e.from] = byId[e.to].name; });
  data.nodes.forEach(function (n) { if (n.kind === 'entrypoint') owner[n.id] = n.feature; });
  var selected = null;
  var feature = '';
  var query = '';
  var details = root.querySelector('.details');
  var count = root.querySelector('.count');
  function label(n) { return n.kind === 'workflow' ? n.name + '@' + n.version : n.name; }
  function text(tag, value, cls) { var el = document.createElement(tag); el.textContent = value; if (cls) el.className = cls; return el; }
  function view() { return root.querySelector('svg.map:not([hidden])'); }
  /** What an edge says from the side of the selected node: 'to' when data flows out of it, 'from' when it flows in. */
  var VERBS = {
    writes: { from: 'written by', to: 'writes' },
    folds: { from: 'folds', to: 'folds into' },
    projects: { from: 'projects', to: 'projects into' },
    reacts: { from: 'reacts to', to: 'feeds' },
    'waits-for': { from: 'waits for', to: 'awaited by' },
    runs: { from: 'run by', to: 'runs' },
    calls: { from: 'called by', to: 'calls' }
  };
  function verb(e, side, other) {
    if (e.kind === 'reacts' && side === 'from' && byId[e.from].kind === 'workflow') return 'starts on';
    if (e.kind === 'reacts' && side === 'to' && other.kind === 'workflow') return 'starts';
    return VERBS[e.kind][side];
  }
  function edgeText(e) {
    var parts = [];
    if (e.node) parts.push('at ' + e.node);
    if (e.label) parts.push('as "' + e.label + '"');
    if (e.undo) parts.push('(undo)');
    if (e.timing) parts.push(e.timing.replace('-', ' '));
    if (e.delivery) parts.push(e.delivery.replace(/-/g, ' '));
    return parts.join(', ');
  }
  function describe() {
    details.textContent = '';
    if (!selected) { details.appendChild(text('p', 'Click a node to see its timing, delivery, owner, dependencies, retry policy and entrypoint files.', 'legend')); return; }
    var n = byId[selected];
    details.appendChild(text('h2', n.kind + ' ' + label(n)));
    var dl = document.createElement('dl');
    function row(k, v) { if (v === undefined || v === null || v === '') return; dl.appendChild(text('dt', k)); dl.appendChild(text('dd', v)); }
    row('Owner feature', owner[n.id] || 'none recorded');
    var cameFrom = [];
    var goesTo = [];
    data.edges.forEach(function (e, i) {
      if (e.kind === 'owned-by') return;
      if (data.flows[i].target === n.id) cameFrom.push({ e: e, other: byId[data.flows[i].source] });
      if (data.flows[i].source === n.id) goesTo.push({ e: e, other: byId[data.flows[i].target] });
    });
    var out = data.edges.filter(function (e) { return e.from === n.id && e.kind !== 'owned-by'; });
    var timed = out.filter(function (e) { return e.timing; })[0];
    if (timed) { row('Timing', timed.timing.replace('-', ' ')); row('Delivery', timed.delivery ? timed.delivery.replace(/-/g, ' ') : 'not set'); }
    if (n.deps) row('Dependencies', n.deps.length ? n.deps.join(', ') : 'none');
    if (n.retry) row('Retry', n.retry.policy + ', ' + (n.retry.maxRetries === null ? 'no limit' : n.retry.maxRetries + ' retries'));
    if (n.kind === 'tap') row('Retry', 'none');
    if (n.kind === 'workflow') { row('Retry', 'per step'); row('Signals', n.signals.join(', ')); row('Steps that may run commands (not drawn)', n.opaqueSteps.join(', ')); }
    if (n.kind === 'projection') row('Lane', n.lane);
    if (n.kind === 'entity') row('Table', n.table);
    if (n.kind === 'entrypoint') row('File', n.file);
    if (n.kind === 'command' || n.kind === 'event') {
      var files = [];
      var seen = {};
      function reach(id, depth) {
        data.edges.forEach(function (e) {
          if (e.to !== id || seen[e.from + id]) return;
          seen[e.from + id] = true;
          var from = byId[e.from];
          if (from && from.kind === 'entrypoint') files.push(from.feature + ': ' + from.file);
          else if (from && from.kind === 'command' && depth < 1) reach(from.id, depth + 1);
        });
      }
      reach(n.id, 0);
      row('Entrypoint files', files.length ? files.join('; ') : 'none found');
    }
    details.appendChild(dl);
    [['Comes from', cameFrom, 'from'], ['Goes to', goesTo, 'to']].forEach(function (g) {
      details.appendChild(text('h3', g[0] + ' (' + g[1].length + ')'));
      var ul = document.createElement('ul');
      g[1].forEach(function (item) {
        var extra = edgeText(item.e);
        ul.appendChild(text('li', verb(item.e, g[2], item.other) + ' ' + item.other.kind + ' ' + label(item.other) + (extra ? ' (' + extra + ')' : '')));
      });
      if (!g[1].length) ul.appendChild(text('li', 'none'));
      details.appendChild(ul);
    });
  }
  function paint() {
    var q = query.trim().toLowerCase();
    var matches = 0;
    root.querySelectorAll('.node').forEach(function (g) {
      var n = byId[g.dataset.id];
      var hit = q !== '' && label(n).toLowerCase().indexOf(q) >= 0;
      if (hit) matches += 1;
      g.classList.toggle('selected', g.dataset.id === selected);
      g.classList.toggle('match', hit);
      g.classList.toggle('faded', selected !== null ? !touches(g.dataset.id) : q !== '' && !hit);
    });
    root.querySelectorAll('.edge').forEach(function (p) {
      var hot = selected !== null && (p.dataset.source === selected || p.dataset.target === selected);
      p.classList.toggle('hot', hot);
      p.classList.toggle('faded', selected !== null && !hot);
    });
    count.textContent = q === '' ? '' : matches + (matches === 1 ? ' match' : ' matches');
  }
  function touches(id) {
    if (id === selected) return true;
    return data.edges.some(function (e) { return e.kind !== 'owned-by' && ((e.from === selected && e.to === id) || (e.to === selected && e.from === id)); });
  }
  function select(id) { selected = selected === id ? null : id; describe(); paint(); }
  root.addEventListener('click', function (event) {
    var g = event.target.closest ? event.target.closest('.node') : null;
    if (g) select(g.dataset.id); else if (event.target.closest && event.target.closest('svg.map')) select(selected);
  });
  root.addEventListener('keydown', function (event) {
    var g = event.target.closest ? event.target.closest('.node') : null;
    if ((event.key === 'Enter' || event.key === ' ') && g) { event.preventDefault(); select(g.dataset.id); }
    if (event.key === 'Escape' && selected) select(selected);
  });
  root.querySelector('select').addEventListener('change', function (event) {
    feature = event.target.value;
    root.querySelectorAll('svg.map').forEach(function (svg) { svg.hidden = svg.dataset.view !== feature; });
    paint();
  });
  root.querySelector('input').addEventListener('input', function (event) { query = event.target.value; paint(); });
  describe();
})();
`;

/**
 * The page for a document that is not an event map: said plainly, so the console shows a reason and not a blank.
 */
const NOT_A_MAP = '<p>This is not an event-map document, so there is nothing to draw.</p>';

/** The console page for `dot explain --as event-map`'s document: the HTML that goes inside the console's shell. */
export function eventMapPage(document: unknown): string {
  if (!is(document, eventMapDocumentSchema)) return NOT_A_MAP;
  const shown: EventMapDocument = {
    format: 'event-map',
    nodes: [...document.nodes],
    edges: [...document.edges],
    problems: [...document.problems],
  };
  const features = featuresOf(shown);
  const eventCount = shown.nodes.filter(node => node.kind === 'event').length;
  const problems =
    shown.problems.length === 0
      ? ''
      : `<section class="problems"><h2>Not scanned (${shown.problems.length})</h2><p>The map is drawn without these procedure files.</p><ul>${shown.problems
          .map(problem => `<li><code>${escapeHtml(problem.file)}</code>: ${escapeHtml(problem.reason)}</li>`)
          .join('')}</ul></section>`;
  const options = [
    '<option value="">All features</option>',
    ...features.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
  ].join('');
  const views = [viewSvg(shown, undefined), ...features.map(name => viewSvg(shown, name))].join('');
  return (
    `<style>${STYLE}</style><div class="em" id="event-map">` +
    `<div><h1>Event map</h1><p class="lede">${eventCount} events, ${shown.nodes.length} nodes, ${shown.edges.length} edges. Commands write events; events feed reactions, workflows and waits; workflows run commands.</p></div>` +
    `<div class="bar"><label>Feature<select>${options}</select></label><label>Search by name<input type="search" placeholder="OrderPlaced" autocomplete="off"></label><span class="count" aria-live="polite"></span></div>` +
    problems +
    `<div class="stage"><div class="scroll">${views}</div><aside class="details" aria-live="polite"></aside></div>` +
    `<p class="legend">Solid lines write or fold, dashed lines wait for an event, dotted lines run a command. Click a node to follow its edges; click it again to clear.</p>` +
    `<script type="application/json" id="event-map-data">${scriptJson({ ...shown, flows: shown.edges.map(flowOf) })}</script><script>${SCRIPT}</script></div>`
  );
}
