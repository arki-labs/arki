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
 *   - calls `runExplain(app, --json)` / `runDoctor(app, --json)` (the public
 *     CLI seams) and validates the `{ status, command, generatedAt, data,
 *     errors }` envelope shape
 *   - calls `runNew({ dryRun: true, json: true })` for a probe app name and
 *     checks the `{ status, command, generatedAt, app, operations, errors }`
 *     envelope plus the presence of every required scaffold file
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

import { db } from '@arki/db/dot';
import { defineApp } from '@arki/dot';
import { runDoctor, runExplain, runNew } from '@arki/dot/cli';
import { env } from '@arki/env/dot';
import { kv } from '@arki/kv/dot';
import { defineRelations } from 'drizzle-orm';
import { pgTable, text } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import type { DotProbeResult } from './types';

/** Required files every `dot new` scaffold must produce. */
export const DOT_PROBE_REQUIRED_FILES = [
  'package.json',
  'tsconfig.json',
  'README.md',
  'AGENTS.md',
  '.gitignore',
] as const;

async function runProbe(): Promise<DotProbeResult> {
  // Schema is incidental — we only assert the adapter publishes a usable
  // service. The fixture uses the same shape.
  const widgets = pgTable('widgets', {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
  });
  const relations = defineRelations({ widgets });

  const app = await defineApp('arki-dot-probe')
    .use(
      env({
        schema: { PROBE_GREETING: z.string().default('hello') },
        skipValidation: true,
      }),
    )
    .use(kv({ url: 'redis://127.0.0.1:1', namespace: 'arki-dot-probe' }))
    .use(db({ driver: 'pglite', memory: true, relations }))
    .boot();

  const tempTarget = mkdtempSync(path.join(tmpdir(), 'arki-dot-probe-'));
  try {
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

    const noopOut = (_line: string): void => {
      /* swallow CLI stdout */
    };

    // `app.manifest` is stable (built once during configure); `app.diagnostics`
    // is a getter that returns a FRESH snapshot on every access. So the
    // explain envelope's `data` is referentially equal to our `manifest`,
    // but the doctor envelope's `data` is a sibling snapshot of `diagnostics`.
    // We use structural shape checks below to avoid identity coupling.
    const explainEnv = await runExplain(app, { json: true, out: noopOut });
    const explainData = explainEnv.data as typeof manifest;
    const explainEnvelopeOk =
      explainEnv.command === 'explain' &&
      typeof explainEnv.generatedAt === 'string' &&
      typeof explainData === 'object' &&
      explainData !== null &&
      typeof explainData.app === 'object' &&
      explainData.app.name === manifest.app.name &&
      Array.isArray(explainData.plugins) &&
      Array.isArray(explainData.actions) &&
      Array.isArray(explainData.services) &&
      Array.isArray(explainData.lifecycle) &&
      Array.isArray(explainData.dependencies) &&
      Array.isArray(explainEnv.errors) &&
      (explainEnv.status === 'success' || explainEnv.status === 'warning');

    const doctorEnv = await runDoctor(app, { json: true, out: noopOut });
    const doctorData = doctorEnv.data as typeof diagnostics;
    const doctorEnvelopeOk =
      doctorEnv.command === 'doctor' &&
      typeof doctorEnv.generatedAt === 'string' &&
      typeof doctorData === 'object' &&
      doctorData !== null &&
      typeof doctorData.app === 'object' &&
      doctorData.app.name === diagnostics.app.name &&
      typeof doctorData.app.state === 'string' &&
      Array.isArray(doctorData.plugins) &&
      Array.isArray(doctorData.actions) &&
      Array.isArray(doctorData.services) &&
      Array.isArray(doctorData.lifecycle) &&
      Array.isArray(doctorData.issues) &&
      Array.isArray(doctorEnv.errors);

    // `dot new --dry-run --json` — capture envelope without printing.
    const newEnv = await runNew({
      name: 'probe-app',
      target: tempTarget,
      dryRun: true,
      json: true,
      out: noopOut,
      err: noopOut,
    });
    const newRequiredFilesPresent = DOT_PROBE_REQUIRED_FILES.filter(required =>
      newEnv.operations.some(op => op.path === required),
    );
    const newEnvelopeOk =
      newEnv.command === 'new' &&
      newEnv.status === 'success' &&
      newEnv.operations.length > 0 &&
      newRequiredFilesPresent.length === DOT_PROBE_REQUIRED_FILES.length &&
      newEnv.operations.every(
        op =>
          typeof op.path === 'string' &&
          typeof op.contentHash === 'string' &&
          op.contentHash.length > 0 &&
          typeof op.contentBytes === 'number' &&
          typeof op.action === 'string' &&
          typeof op.reason === 'string',
      );

    return {
      status: 'pass',
      pluginCount: manifest.plugins.length,
      manifestArrays,
      diagnosticsArrays,
      explainEnvelopeOk,
      doctorEnvelopeOk,
      newEnvelopeOk,
      newOperationCount: newEnv.operations.length,
      newRequiredFilesPresent,
      appState: String(app.state),
    };
  } finally {
    rmSync(tempTarget, { recursive: true, force: true });
    try {
      await app.dispose();
    } catch {
      /* dispose errors don't invalidate the probe — diagnostics already captured */
    }
  }
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
