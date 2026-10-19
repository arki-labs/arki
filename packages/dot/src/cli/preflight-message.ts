/** The child preflight report shared by command failures and the dev supervisor. */
import { z } from 'zod';

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
