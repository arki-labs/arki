import type { z } from 'zod/v4';

import type { JobHandler, ScheduleConfig, ScheduleDefinition, ScheduleOptions } from './types/index.ts';

/**
 * Define a scheduled job (cron or interval)
 *
 * @example Cron-based schedule
 * ```typescript
 * export const dailyCleanup = defineSchedule({
 *   name: 'maintenance:daily-cleanup',
 *   schedule: {
 *     type: 'cron',
 *     pattern: '0 2 * * *', // Every day at 2 AM
 *     timezone: 'America/New_York',
 *   },
 *   schema: z.object({
 *     dryRun: z.boolean().default(false),
 *   }),
 *   handler: async (data, ctx) => {
 *     await ctx.repositories.cleanup.removeOldData();
 *     return { cleaned: true };
 *   },
 * });
 * ```
 *
 * @example Interval-based schedule
 * ```typescript
 * export const healthCheck = defineSchedule({
 *   name: 'system:health-check',
 *   schedule: {
 *     type: 'interval',
 *     milliseconds: 60000, // Every minute
 *   },
 *   schema: z.object({}),
 *   handler: async (data, ctx) => {
 *     const health = await checkSystemHealth();
 *     return { healthy: health.allSystemsGo };
 *   },
 * });
 * ```
 */
export function defineSchedule<TInput, TOutput = unknown>(config: {
  /**
   * Unique name for this schedule (e.g., 'maintenance:daily-cleanup')
   * Use the pattern: featureName:jobType
   */
  name: string;

  /**
   * Schedule configuration (cron pattern or interval)
   */
  schedule: ScheduleConfig;

  /**
   * Zod schema for validating job data
   */
  schema: z.ZodType<TInput>;

  /**
   * Handler function to process the scheduled job
   */
  handler: JobHandler<TInput, TOutput>;

  /**
   * Schedule options
   */
  options?: ScheduleOptions<TInput, TOutput>;
}): ScheduleDefinition<TInput, TOutput> {
  return {
    name: config.name,
    schedule: config.schedule,
    schema: config.schema,
    handler: config.handler,
    options: config.options,
  };
}
