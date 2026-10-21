/**
 * Renderer for `dot explain --graph` / `dot doctor --graph`.
 *
 * Emits the app's plugin graph as [Mermaid](https://mermaid.js.org) `flowchart`
 * source — paste-able into GitHub markdown, docs, and mermaid.live.
 *
 * The nodes are the plugins in declaration order (which IS boot order in v2 —
 * the numbering makes that visible); the edges are the manifest's dependency
 * edges. Capability edges between features are derived before boot from
 * their static `provides` and labelled with the capability key, so
 * `explain` (which never boots) draws them; the rest are **observed** when a
 * plugin's need is satisfied during boot, so `doctor` shows the full wiring.
 */

import { is, recordSchema } from '@arki/schema';

import type { DotAppManifest } from '../manifest.js';

/** The `data` of `--graph`: Mermaid source. */
export type GraphData = {
  format: 'mermaid';
  /** Mermaid `flowchart` source. */
  source: string;
};

/** Escape a plugin name for use inside a quoted Mermaid node label. */
function escapeLabel(name: string): string {
  return name.replaceAll('"', '#quot;');
}

/** Hexagon groups, in boot order. A plugin without a role is a driven adapter. */
const GROUPS = [
  { id: 'driven', label: 'driven · what features need', role: undefined },
  { id: 'features', label: 'features · the domain', role: 'feature' },
  { id: 'driving', label: 'driving · what calls the features', role: 'driving' },
] as const;

/**
 * Build Mermaid `flowchart` source from a manifest. Deterministic: node
 * ids follow declaration order, edges follow manifest order. An app built
 * with `.features()` / `.serve()` is drawn as the hexagon's three groups;
 * any other app is a flat list.
 */
export function buildMermaidGraph(manifest: DotAppManifest): string {
  const lines: string[] = ['flowchart TD', '  %% numbers = boot order'];
  const idByPlugin = new Map<string, string>();
  const nodes = manifest.plugins.map((plugin, index) => {
    const id = `p${index.toString()}`;
    idByPlugin.set(plugin.name, id);
    const order = (index + 1).toString();
    return { role: plugin.role, line: `${id}["${order} · ${escapeLabel(plugin.name)}"]` };
  });

  if (nodes.some(node => node.role !== undefined)) {
    for (const group of GROUPS) {
      const members = nodes.filter(node => node.role === group.role);
      if (members.length === 0) continue;
      lines.push(`  subgraph ${group.id}["${group.label}"]`, ...members.map(node => `    ${node.line}`), '  end');
    }
  } else {
    lines.push(...nodes.map(node => `  ${node.line}`));
  }

  for (const edge of manifest.dependencies) {
    const from = idByPlugin.get(edge.from);
    const to = idByPlugin.get(edge.to);
    // Edges referencing unknown plugins would be a kernel bug — skip rather
    // than emit invalid Mermaid.
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} -->|${edge.key ?? edge.kind}| ${to}`);
  }

  return `${lines.join('\n')}\n`;
}

/** The graph payload of `explain --graph` / `doctor --graph`. Text mode prints `source` as is. */
export function renderGraph(manifest: DotAppManifest): GraphData {
  return { format: 'mermaid', source: buildMermaidGraph(manifest) };
}

/** True when a command's data is the `--graph` payload. */
export function isGraphData(value: unknown): value is GraphData {
  return (
    is(value, recordSchema) && value['format'] === 'mermaid' && 'source' in value
  );
}
