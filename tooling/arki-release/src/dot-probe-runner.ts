#!/usr/bin/env bun
/**
 * DOT probe runner — the subprocess that validates the @arki/dot kernel
 * contracts on behalf of the release scorecard.
 *
 * Run as a subprocess by {@link runDotProbe}. Imports @arki/dot, @arki/env,
 * @arki/kv, @arki/db directly via workspace resolution, boots a synthetic
 * three-adapter DOT app, then:
 *
 *   - reads `app.manifest` and asserts the five contract arrays are
 *     present (plugins, actions, services, lifecycle, dependencies)
 *   - reads `app.diagnostics` and asserts the five contract arrays are
 *     present (plugins, actions, services, lifecycle, issues)
 *   - runs the `dot` program in-process (`program.main` from `@arki/dot/cli`,
 *     the public CLI seam) with captured stdout: `explain --json` and
 *     `doctor --json` against this file's default export, and checks the
 *     `arki.cli/1` envelope (`ok`, `command`, `meta.schema`) and the `.data`
 *     shape (the manifest; the diagnostics report, which a doctor that finds
 *     errors returns as `.error.data` of `dot.doctor_failed`)
 *   - runs `dot new probe-app --dry-run --json` and checks `.data.app`,
 *     `.data.operations[]` and the presence of every required scaffold file
 *
 * Emits a {@link DotProbeResult} JSON object on stdout. Non-zero exit code
 * signals an unexpected throw — the scorecard surfaces it as a probe
 * failure.
 *
 * This file is deliberately a script, not a library — it is spawned via
 * `bun` so its module graph (which pulls in @arki/dot + adapters) stays
 * out of the scorecard's own bundle.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { db } from '@arki/db/dot';
import { defineApp } from '@arki/dot';
import { program } from '@arki/dot/cli';
import { env } from '@arki/env/dot';
import { isFailure } from '@arki/failure';
import { kv } from '@arki/kv/dot';

import type { DotProbeResult } from './types';

/** Required files every `dot new` scaffold must produce. */
export const DOT_PROBE_REQUIRED_FILES = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'AGENTS.md',
  '.gitignore',
] as const;

/**
 * The synthetic three-adapter app. The default export is what `dot explain` /
 * `dot doctor --app <this file>` discover, the way they discover a user's app.
 */
function probeApp() {
  // Schema is incidental — we only assert the adapter publishes a usable
  // service. The fixture uses the same shape.
  const widgets = pgTable('widgets', {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
  });
  const relations = defineRelations({ widgets });

  return defineApp('arki-dot-probe')
    .use(
      env({
        schema: { PROBE_GREETING: z.string().default('hello') },
        skipValidation: true,
      }),
    )
    .use(kv({ url: 'redis://127.0.0.1:1', namespace: 'arki-dot-probe' }))
    .use(db({ driver: 'pglite', memory: true, relations }));
}

export default probeApp();

const THIS_FILE = fileURLToPath(import.meta.url);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The value at a key path, or `undefined` when a step is not an object. */
function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Run one `dot` command line in-process with stdout captured, and parse the envelope it prints. */
async function dot(argv: readonly string[]): Promise<{ readonly code: number; readonly envelope: unknown }> {
  let stdout = '';
  const code = await program.main([...argv, '--json'], {
    stdout: chunk => {
      stdout += chunk;
    },
  });
  const envelope: unknown = JSON.parse(stdout);
  return { code, envelope };
}

/** True when the envelope is `arki.cli/1` for this command. */
function isEnvelopeFor(envelope: unknown, command: string): boolean {
  const path = at(envelope, 'command');
  return (
    at(envelope, 'meta', 'schema') === 'arki.cli/1' && Array.isArray(path) && path.length === 1 && path[0] === command
  );
}

function hasArrays(value: unknown, keys: readonly string[]): boolean {
  return keys.every(key => Array.isArray(at(value, key)));
}

async function runProbe(): Promise<DotProbeResult> {
  const app = await probeApp().boot();
  if (isFailure(app)) return { status: 'fail', reason: `Dot boot failed: ${app.code}` };

  let tempTarget: string | undefined;
  let report: DotProbeResult;
  let disposal: Awaited<ReturnType<typeof app.dispose>>;
  try {
    tempTarget = mkdtempSync(path.join(tmpdir(), 'arki-dot-probe-'));
    const manifest = app.manifest;
    const diagnostics = app.diagnostics;

    const manifestArrays =
      Number(Array.isArray(manifest.plugins)) +
      Number(Array.isArray(manifest.actions)) +
      Number(Array.isArray(manifest.services)) +
      Number(Array.isArray(manifest.lifecycle)) +
      Number(Array.isArray(manifest.dependencies));

    const diagnosticsArrays =
      Number(Array.isArray(diagnostics.plugins)) +
      Number(Array.isArray(diagnostics.actions)) +
      Number(Array.isArray(diagnostics.services)) +
      Number(Array.isArray(diagnostics.lifecycle)) +
      Number(Array.isArray(diagnostics.issues));

    // `dot explain` configures its own copy of the app (never boots); `.data`
    // is the manifest. Shape checks only, no identity coupling.
    const explained = await dot(['explain', '--app', THIS_FILE]);
    const explainData = at(explained.envelope, 'data');
    const explainEnvelopeOk =
      explained.code === 0 &&
      at(explained.envelope, 'ok') === true &&
      isEnvelopeFor(explained.envelope, 'explain') &&
      at(explainData, 'app', 'name') === manifest.app.name &&
      hasArrays(explainData, ['plugins', 'actions', 'services', 'lifecycle', 'dependencies']);

    // `dot doctor` boots and disposes its own copy. A doctor that finds error
    // issues exits 3 with `dot.doctor_failed` and the report in `.error.data`;
    // the probe checks the report's shape either way.
    const doctored = await dot(['doctor', '--app', THIS_FILE]);
    const doctorPassed = doctored.code === 0 && at(doctored.envelope, 'ok') === true;
    const doctorFailed = doctored.code === 3 && at(doctored.envelope, 'error', 'code') === 'dot.doctor_failed';
    const doctorReport = doctorPassed ? at(doctored.envelope, 'data') : at(doctored.envelope, 'error', 'data');
    const doctorEnvelopeOk =
      (doctorPassed || doctorFailed) &&
      isEnvelopeFor(doctored.envelope, 'doctor') &&
      typeof at(doctorReport, 'status') === 'string' &&
      at(doctorReport, 'app', 'name') === diagnostics.app.name &&
      typeof at(doctorReport, 'app', 'state') === 'string' &&
      hasArrays(doctorReport, ['plugins', 'actions', 'services', 'lifecycle', 'issues']);

    // `dot new --dry-run` plans the scaffold and writes nothing.
    const scaffolded = await dot(['new', 'probe-app', '--target', tempTarget, '--dry-run']);
    const rawOperations = at(scaffolded.envelope, 'data', 'operations');
    const operations = Array.isArray(rawOperations) ? rawOperations : [];
    const newRequiredFilesPresent = DOT_PROBE_REQUIRED_FILES.filter(required =>
      operations.some(op => at(op, 'path') === required),
    );
    const newEnvelopeOk =
      scaffolded.code === 0 &&
      at(scaffolded.envelope, 'ok') === true &&
      isEnvelopeFor(scaffolded.envelope, 'new') &&
      at(scaffolded.envelope, 'meta', 'dryRun') === true &&
      at(scaffolded.envelope, 'data', 'app', 'name') === 'probe-app' &&
      operations.length > 0 &&
      newRequiredFilesPresent.length === DOT_PROBE_REQUIRED_FILES.length &&
      operations.every(
        op =>
          typeof at(op, 'path') === 'string' &&
          typeof at(op, 'contentHash') === 'string' &&
          String(at(op, 'contentHash')).length > 0 &&
          typeof at(op, 'contentBytes') === 'number' &&
          typeof at(op, 'action') === 'string' &&
          typeof at(op, 'reason') === 'string',
      );

    report = {
      status: 'pass',
      pluginCount: manifest.plugins.length,
      manifestArrays,
      diagnosticsArrays,
      explainEnvelopeOk,
      doctorEnvelopeOk,
      newEnvelopeOk,
      newOperationCount: operations.length,
      newRequiredFilesPresent,
      appState: String(app.state),
    };
  } catch (cause) {
    report = { status: 'fail', reason: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    disposal = await app.dispose();
    if (tempTarget !== undefined) rmSync(tempTarget, { recursive: true, force: true });
  }
  if (isFailure(disposal)) {
    return {
      status: 'fail',
      reason: `${report.status === 'fail' ? `${report.reason}; ` : ''}Dot disposal failed: ${disposal.code}`,
    };
  }
  return report;
}

void (async (): Promise<void> => {
  try {
    const result = await runProbe();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (err) {
    const failure: DotProbeResult = {
      status: 'fail',
      reason: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stderr: err.stack } : {}),
    };
    process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.exit(1);
  }
})();
