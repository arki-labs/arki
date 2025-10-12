import type { z } from 'zod/v4';

import type { JobDefinition, JobHandler, JobOptions } from './types/index.ts';

/**
 * Define a job for on-demand processing
 *
 * @example
 * ```typescript
 * export const sendEmail = defineJob({
 *   name: 'notifications:send-email',
 *   inputSchema: z.object({
 *     to: z.string().email(),
 *     subject: z.string(),
 *     body: z.string(),
 *   }),
 *   handler: async (data, ctx) => {
 *     await ctx.services.email.send(data);
 *     return { sent: true };
 *   },
 *   options: {
 *     maxParallelism: 50,
 *     retry: {
 *       attempts: 3,
 *       backoff: { type: 'exponential', delay: 1000, base: 2 },
 *     },
 *     onComplete: async (job, result) => {
 *       await logEmailSent(job.data.to, result);
 *     },
 *   },
 * });
 * ```
 */
export function defineJob<TInput, TOutput = unknown>(config: {
  /**
   * Unique name for this job (e.g., 'notifications:send-email')
   * Use the pattern: featureName:jobType
   */
  name: string;

  /**
   * Zod schema for validating job input data
   */
  inputSchema: z.ZodType<TInput>;

  /**
   * Handler function to process the job
   */
  handler: JobHandler<TInput, TOutput>;

  /**
   * Job options
   */
  options?: JobOptions<TInput, TOutput>;
}): JobDefinition<TInput, TOutput> {
  return {
    name: config.name,
    inputSchema: config.inputSchema,
    handler: config.handler,
    options: config.options,
  };
}
