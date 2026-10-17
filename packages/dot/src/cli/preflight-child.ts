/**
 * The preflight of `dot dev`, in its own process: `dot _preflight` imports
 * the app afresh, boots its `dev` export the way `dot doctor` does (env
 * validation, committed migrations), disposes it, and prints one JSON report.
 *
 * A fresh process per preflight is the point: an edit to the app file, a
 * changed `.env` or a module that reads env at import is seen by the next
 * check, and the supervisor never configures the app itself (so it never
 * holds the app's logging slot). The report travels as the `@arki/cli`
 * envelope on stdout (`--output json`): one line, last, validated by the
 * supervisor with `preflightMessageSchema`.
 */
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { isFailure } from '@arki/failure';

import type { DiscoveredApp } from './discover.js';
import { discoverApp, guards } from './discover.js';
import { runDoctor } from './doctor.js';
import { DevAppStarted, DoctorFailed, lifecycleFailed } from './failures.js';
import { isGraphData } from './render-graph.js';

const issuesSchema = z.array(z.looseObject({ code: z.string() }));
const withIssuesSchema = z.array(z.looseObject({ issues: issuesSchema }));

/** What `dot _preflight` reports. Written once here; the supervisor parses it with the same schema. */
export const preflightMessageSchema = z.object({
  /** The app that was checked; null when discovery or configure failed. */
  app: z.object({ file: z.string(), exportName: z.string(), plugins: z.number(), features: z.number() }).nullable(),
  /** The `migrations` service of `dbMigrations`: what this boot found pending and applied. */
  migrations: z.array(z.string()).nullable(),
  /** The doctor report (`DoctorReport`), when the boot ran. Shape-checked here, typed by the doctor guard. */
  report: z
    .looseObject({
      status: z.enum(['success', 'warning', 'failure']),
      plugins: withIssuesSchema,
      actions: withIssuesSchema,
      services: withIssuesSchema,
      lifecycle: withIssuesSchema,
      issues: issuesSchema,
    })
    .nullable(),
  /** The failure, as JSON: `revive` it with the CLI's definitions. */
  failure: z.object({ code: z.string(), message: z.string(), data: z.unknown() }).nullable(),
});
export type PreflightMessage = z.infer<typeof preflightMessageSchema>;

/**
 * The `migrations` service of `@arki/db`'s `dbMigrations`, matched by shape so
 * the kernel never imports `@arki/db`. An app without it reports null.
 */
const migrationsServiceSchema = z.object({ pending: z.array(z.string()) });

function asJson(failure: Failure): NonNullable<PreflightMessage['failure']> {
  return { code: failure.code, message: failure.message, data: failure.data };
}

/** Discover, configure once, boot through `runDoctor`, dispose: the report of one preflight. */
export async function runPreflightChild(options: {
  readonly app?: string | undefined;
  readonly cwd?: string | undefined;
}): Promise<PreflightMessage> {
  const none = { app: null, migrations: null, report: null } as const;
  const discovered = await discoverApp({ appPath: options.app, cwd: options.cwd, prefer: 'dev' });
  if (isFailure(discovered)) return { ...none, failure: asJson(discovered) };
  const builder: DiscoveredApp = discovered.app;
  if (!guards.isDotAppBuilder(builder)) {
    return {
      ...none,
      failure: asJson(DevAppStarted({ filePath: discovered.filePath, exportName: discovered.exportName })),
    };
  }
  let configured;
  try {
    configured = builder.configure();
  } catch (error) {
    return { ...none, failure: asJson(lifecycleFailed(error, 'configure')) };
  }
  const { plugins } = configured.manifest;
  const app = {
    file: discovered.filePath,
    exportName: discovered.exportName,
    plugins: plugins.length,
    features: plugins.filter(entry => entry.role === 'feature').length,
  };

  let migrations: string[] | null = null;
  const result = await runDoctor(configured, {
    onBooted: booted => {
      const parsed = migrationsServiceSchema.safeParse(booted.services['migrations']);
      migrations = parsed.success ? parsed.data.pending : null;
    },
  });
  if (isFailure(result)) {
    return { app, migrations, report: DoctorFailed.is(result) ? result.data : null, failure: asJson(result) };
  }
  return { app, migrations, report: isGraphData(result) ? null : result, failure: null };
}
