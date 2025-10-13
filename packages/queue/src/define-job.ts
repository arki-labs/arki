import type { z } from 'zod/v4';

import type { JobDefinition, JobHandler, JobOptions } from './types/index.ts';

/**
 * Define a job for on-demand processing
 *
 * @template TInput - Type of input data for the job
 * @template TOutput - Type of output/result from the job
 * @template TDeps - Custom dependencies available in context (default: no dependencies)
 *
 * @example Basic job without dependencies
 * ```typescript
 * export const sendEmail = defineJob({
 *   name: 'notifications:send-email',
 *   inputSchema: z.object({
 *     to: z.string().email(),
 *     subject: z.string(),
 *     body: z.string(),
 *   }),
 *   handler: async (data, ctx) => {
 *     await ctx.log(`Sending email to ${data.to}`);
 *     return { sent: true };
 *   },
 *   options: {
 *     maxParallelism: 50,
 *     retry: {
 *       attempts: 3,
 *       backoff: { type: 'exponential', delay: 1000, base: 2 },
 *     },
 *   },
 * });
 * ```
 *
 * @example Job with typed dependencies
 * ```typescript
 * type MyDependencies = {
 *   db: Database;
 *   repo: Repositories;
 *   email: EmailService;
 * };
 *
 * export const sendEmail = defineJob<EmailInput, EmailResult, MyDependencies>({
 *   name: 'notifications:send-email',
 *   inputSchema: z.object({
 *     to: z.string().email(),
 *     subject: z.string(),
 *     body: z.string(),
 *   }),
 *   handler: async (data, ctx) => {
 *     // ctx now has access to db, repo, email
 *     await ctx.email.send(data);
 *     await ctx.repo.notifications.logEmailSent(data.to);
 *     return { sent: true };
 *   },
 * });
 * ```
 */
export function defineJob<TInput, TOutput = unknown, TDeps = Record<string, never>>(config: {
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
  handler: JobHandler<TInput, TOutput, TDeps>;

  /**
   * Job options
   */
  options?: JobOptions<TInput, TOutput, TDeps>;
}): JobDefinition<TInput, TOutput, TDeps> {
  return {
    name: config.name,
    inputSchema: config.inputSchema,
    handler: config.handler,
    options: config.options,
  };
}
