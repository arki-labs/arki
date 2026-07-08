/**
 * Renderers for `dot explain`.
 *
 * Reads a configured (or booted) app's `manifest` and emits one of:
 *   - JSON envelope to stdout (when --json)
 *   - human-readable plain text to stdout (default)
 *
 * The JSON envelope shape matches the broader release-tooling envelope so
 * agents can parse the output identically across CLI surfaces.
 */

import type { DiagnosticIssue } from '../diagnostics.js';
import type { DotAppManifest } from '../manifest.js';

export type DotCliEnvelopeStatus = 'success' | 'failure' | 'warning';

export type DotCliEnvelope<T = unknown> = {
  status: DotCliEnvelopeStatus;
  command: string;
  generatedAt: string;
  data: T;
  errors: DiagnosticIssue[];
};

export type ExplainSource = {
  /** The static manifest produced by configure (or read off a booted app). */
  manifest: DotAppManifest;
};

export type RenderOptions = {
  /** Set to true to emit JSON to stdout; otherwise pretty text. */
  json: boolean;
  /** Override clock for deterministic test output. */
  now?: () => Date;
  /** Override stdout sink. Defaults to `process.stdout.write`. */
  out?: (line: string) => void;
};

const defaultOut = (line: string) => {
  process.stdout.write(line);
};

function nowIso(opts: RenderOptions): string {
  const factory = opts.now ?? (() => new Date());
  return factory().toISOString();
}

/**
 * Build the envelope without writing anything. Useful for tests that need
 * to assert shape and for embedding the CLI logic from other tools.
 */
export function buildExplainEnvelope(source: ExplainSource, opts: RenderOptions): DotCliEnvelope<DotAppManifest> {
  return {
    status: 'success',
    command: 'explain',
    generatedAt: nowIso(opts),
    data: source.manifest,
    errors: [],
  };
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function renderTextManifest(manifest: DotAppManifest): string {
  const lines: string[] = [];
  const title = `App: ${manifest.app.name}${manifest.app.version ? `@${manifest.app.version}` : ''}`;
  lines.push(title);
  lines.push('='.repeat(title.length));
  lines.push('');

  // Plugins
  lines.push(`Plugins (${manifest.plugins.length})`);
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
  lines.push('');

  // Services
  lines.push(`Services (${manifest.services.length})`);
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
  lines.push('');

  // Actions
  lines.push(`Actions (${manifest.actions.length})`);
  if (manifest.actions.length === 0) {
    lines.push('  (none)');
  } else {
    const widthId = Math.max(2, ...manifest.actions.map(action => action.id.length));
    const widthBinding = Math.max(7, ...manifest.actions.map(action => action.binding.length));
    const widthAddress = Math.max(7, ...manifest.actions.map(action => (action.address ?? '-').length));
    lines.push(`  ${pad('ID', widthId)}  ${pad('BINDING', widthBinding)}  DIR  ${pad('ADDRESS', widthAddress)}  PLUGIN`);
    for (const action of manifest.actions) {
      lines.push(
        `  ${pad(action.id, widthId)}  ${pad(action.binding, widthBinding)}  ${pad(action.direction, 3)}  ${pad(action.address ?? '-', widthAddress)}  ${action.plugin}`,
      );
    }
  }
  lines.push('');

  // Projections
  lines.push(`Projections (${manifest.projections.length})`);
  if (manifest.projections.length === 0) {
    lines.push('  (none)');
  } else {
    const widthFormat = Math.max(6, ...manifest.projections.map(projection => projection.format.length));
    const widthBinding = Math.max(7, ...manifest.projections.map(projection => projection.binding.length));
    const widthModule = Math.max(6, ...manifest.projections.map(projection => projection.module.length));
    lines.push(`  ${pad('FORMAT', widthFormat)}  ${pad('BINDING', widthBinding)}  ${pad('MODULE', widthModule)}  PLUGIN`);
    for (const projection of manifest.projections) {
      lines.push(
        `  ${pad(projection.format, widthFormat)}  ${pad(projection.binding, widthBinding)}  ${pad(projection.module, widthModule)}  ${projection.plugin}`,
      );
    }
  }
  lines.push('');

  // Dependencies
  lines.push(`Dependencies (${manifest.dependencies.length})`);
  if (manifest.dependencies.length === 0) {
    lines.push('  (none)');
  } else {
    for (const d of manifest.dependencies) {
      lines.push(`  ${d.from} --[${d.kind}]--> ${d.to}`);
    }
  }
  lines.push('');

  // Lifecycle
  lines.push(`Lifecycle hooks (${manifest.lifecycle.length})`);
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

/**
 * Render the explain output. Returns the envelope so callers can act on it
 * (e.g. set the process exit code based on `status`).
 */
export function renderExplain(source: ExplainSource, opts: RenderOptions): DotCliEnvelope<DotAppManifest> {
  const envelope = buildExplainEnvelope(source, opts);
  const out = opts.out ?? defaultOut;

  if (opts.json) {
    out(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    out(`${renderTextManifest(source.manifest)}\n`);
  }

  return envelope;
}
