/**
 * Text renderer for `dot explain`: the manifest as plain-text tables. In
 * json mode the manifest is the envelope's `data` and this never runs.
 */

import type { Ui } from '@arki/cli';

import type { DotAppManifest } from '../manifest.js';

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/**
 * An rpc action's contract meta, one `key: value` per line (`policy: order.refund`, `auth: admin`).
 * The rpc adapter puts it under `meta.meta`; `--json` carries the same object.
 */
function contractMetaLines(action: DotAppManifest['actions'][number]): string[] {
  const meta = action.binding === 'rpc' ? action.meta?.['meta'] : undefined;
  if (meta === undefined || meta === null || typeof meta !== 'object' || Array.isArray(meta)) return [];
  return Object.entries(meta).map(
    ([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

function renderTextManifest(manifest: DotAppManifest): string {
  const lines: string[] = [];
  const title = `App: ${manifest.app.name}${manifest.app.version ? `@${manifest.app.version}` : ''}`;
  lines.push(title, '='.repeat(title.length), '', `Plugins (${manifest.plugins.length})`);
  if (manifest.plugins.length === 0) {
    lines.push('  (none)');
  } else {
    const widthName = Math.max(6, ...manifest.plugins.map(p => p.name.length));
    lines.push(`  ${pad('NAME', widthName)}  VERSION  DEPENDENCIES`);
    for (const p of manifest.plugins) {
      const version = p.version ?? '-';
      const deps = p.dependencies.length > 0 ? p.dependencies.join(', ') : '-';
      lines.push(`  ${pad(p.name, widthName)}  ${pad(version, 7)}  ${deps}`);
    }
  }
  lines.push('', `Services (${manifest.services.length})`);
  if (manifest.services.length === 0) {
    lines.push('  (none)');
  } else {
    const widthName = Math.max(4, ...manifest.services.map(s => s.name.length));
    const widthKind = Math.max(4, ...manifest.services.map(s => s.kind.length));
    lines.push(`  ${pad('NAME', widthName)}  ${pad('KIND', widthKind)}  PLUGIN`);
    for (const s of manifest.services) {
      lines.push(`  ${pad(s.name, widthName)}  ${pad(s.kind, widthKind)}  ${s.plugin}`);
    }
  }
  lines.push('', `Actions (${manifest.actions.length})`);
  if (manifest.actions.length === 0) {
    lines.push('  (none)');
  } else {
    const widthId = Math.max(2, ...manifest.actions.map(action => action.id.length));
    const widthBinding = Math.max(7, ...manifest.actions.map(action => action.binding.length));
    const widthAddress = Math.max(7, ...manifest.actions.map(action => (action.address ?? '-').length));
    lines.push(
      `  ${pad('ID', widthId)}  ${pad('BINDING', widthBinding)}  DIR  ${pad('ADDRESS', widthAddress)}  PLUGIN`,
    );
    for (const action of manifest.actions) {
      lines.push(
        `  ${pad(action.id, widthId)}  ${pad(action.binding, widthBinding)}  ${pad(action.direction, 3)}  ${pad(action.address ?? '-', widthAddress)}  ${action.plugin}`,
      );
      if (action.summary !== undefined) lines.push(`      ↳ ${action.summary}`);
      for (const entry of contractMetaLines(action)) lines.push(`      ↳ ${entry}`);
    }
  }
  lines.push('', `Projections (${manifest.projections.length})`);
  if (manifest.projections.length === 0) {
    lines.push('  (none)');
  } else {
    const widthFormat = Math.max(6, ...manifest.projections.map(projection => projection.format.length));
    const widthBinding = Math.max(7, ...manifest.projections.map(projection => projection.binding.length));
    const widthModule = Math.max(6, ...manifest.projections.map(projection => projection.module.length));
    lines.push(
      `  ${pad('FORMAT', widthFormat)}  ${pad('BINDING', widthBinding)}  ${pad('MODULE', widthModule)}  PLUGIN`,
    );
    for (const projection of manifest.projections) {
      lines.push(
        `  ${pad(projection.format, widthFormat)}  ${pad(projection.binding, widthBinding)}  ${pad(projection.module, widthModule)}  ${projection.plugin}`,
      );
    }
  }
  lines.push('', `Dependencies (${manifest.dependencies.length})`);
  if (manifest.dependencies.length === 0) {
    lines.push('  (none)');
  } else {
    for (const d of manifest.dependencies) {
      lines.push(`  ${d.from} --[${d.key ?? d.kind}]--> ${d.to}`);
    }
  }
  lines.push('', `Lifecycle hooks (${manifest.lifecycle.length})`);
  if (manifest.lifecycle.length === 0) {
    lines.push('  (none)');
  } else {
    const widthPlugin = Math.max(6, ...manifest.lifecycle.map(l => l.plugin.length));
    lines.push(`  ${pad('PLUGIN', widthPlugin)}  HOOKS`);
    for (const l of manifest.lifecycle) {
      const hooks = l.hooks.length > 0 ? l.hooks.join(', ') : '-';
      lines.push(`  ${pad(l.plugin, widthPlugin)}  ${hooks}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Print the manifest as text: plugins, services, actions, projections, dependencies, lifecycle hooks. */
export function renderExplainText(manifest: DotAppManifest, ui: Ui): void {
  ui.out(renderTextManifest(manifest));
}
