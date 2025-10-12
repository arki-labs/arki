import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { defineJob } from './define-job';

describe('defineJob', () => {
  describe('basic functionality', () => {
    it('should create a job definition with required fields', () => {
      const job = defineJob({
        name: 'test:basic-job',
        inputSchema: z.object({
          message: z.string(),
        }),
        handler: async data => {
          return { processed: true, message: data.message };
        },
      });

      expect(job.name).toBe('test:basic-job');
      expect(job.inputSchema).toBeDefined();
      expect(job.handler).toBeDefined();
      expect(job.options).toBeUndefined();
    });

    it('should create a job definition with all options', () => {
      const onCompleteMock = async () => {
        /* no-op */
      };
      const onErrorMock = async () => {
        /* no-op */
      };

      const job = defineJob({
        name: 'test:full-job',
        inputSchema: z.object({
          id: z.string(),
          count: z.number(),
        }),
        handler: async data => ({ result: data.count * 2 }),
        options: {
          maxParallelism: 10,
          retry: {
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 1000,
              base: 2,
            },
          },
          onComplete: onCompleteMock,
          onError: onErrorMock,
          bullmqOptions: {
            removeOnComplete: true,
          },
          workerOptions: {
            concurrency: 5,
          },
        },
      });

      expect(job.name).toBe('test:full-job');
      expect(job.options?.maxParallelism).toBe(10);
      expect(job.options?.retry?.attempts).toBe(3);
      expect(job.options?.retry?.backoff.type).toBe('exponential');
      expect(job.options?.onComplete).toBe(onCompleteMock);
      expect(job.options?.onError).toBe(onErrorMock);
      expect(job.options?.bullmqOptions?.removeOnComplete).toBe(true);
      expect(job.options?.workerOptions?.concurrency).toBe(5);
    });
  });

  describe('handler function', () => {
    it('should execute handler with correct input', async () => {
      const job = defineJob({
        name: 'test:handler',
        inputSchema: z.object({
          value: z.number(),
        }),
        handler: async data => {
          return { doubled: data.value * 2 };
        },
      });

      const mockContext = {
        updateProgress: async () => {},
        log: async () => {},
        job: {} as any,
      };

      const result = await job.handler({ value: 5 }, mockContext);
      expect(result).toEqual({ doubled: 10 });
    });

    it('should allow handler to use context methods', async () => {
      const logs: string[] = [];
      const progress: number[] = [];

      const job = defineJob({
        name: 'test:context',
        inputSchema: z.object({
          steps: z.number(),
        }),
        handler: async (data, ctx) => {
          for (let i = 0; i < data.steps; i++) {
            await ctx.log(`Step ${i + 1}`);
            await ctx.updateProgress((i + 1) * 25);
          }
          return { completed: true };
        },
      });

      const mockContext = {
        updateProgress: async (p: number) => {
          progress.push(p);
        },
        log: async (msg: string) => {
          logs.push(msg);
        },
        job: {} as any,
      };

      await job.handler({ steps: 4 }, mockContext);

      expect(logs).toEqual(['Step 1', 'Step 2', 'Step 3', 'Step 4']);
      expect(progress).toEqual([25, 50, 75, 100]);
    });
  });

  describe('schema validation', () => {
    it('should work with simple schemas', () => {
      const job = defineJob({
        name: 'test:simple-schema',
        inputSchema: z.string(),
        handler: async data => ({ length: data.length }),
      });

      expect(job.inputSchema.parse('hello')).toBe('hello');
      expect(() => job.inputSchema.parse(123)).toThrow();
    });

    it('should work with complex nested schemas', () => {
      const job = defineJob({
        name: 'test:complex-schema',
        inputSchema: z.object({
          user: z.object({
            id: z.string(),
            email: z.string().email(),
          }),
          metadata: z.record(z.string(), z.any()),
          tags: z.array(z.string()),
        }),
        handler: async data => ({ userId: data.user.id }),
      });

      const validData = {
        user: {
          id: 'user_123',
          email: 'test@example.com',
        },
        metadata: {
          source: 'api',
          version: '1.0',
        },
        tags: ['important', 'urgent'],
      };

      expect(job.inputSchema.parse(validData)).toEqual(validData);
    });

    it('should work with optional fields', () => {
      const job = defineJob({
        name: 'test:optional',
        inputSchema: z.object({
          required: z.string(),
          optional: z.string().optional(),
        }),
        handler: async data => ({ hasOptional: !!data.optional }),
      });

      expect(job.inputSchema.parse({ required: 'test' })).toEqual({ required: 'test' });
      expect(job.inputSchema.parse({ required: 'test', optional: 'value' })).toEqual({
        required: 'test',
        optional: 'value',
      });
    });

    it('should work with transformed schemas', () => {
      const job = defineJob({
        name: 'test:transform',
        inputSchema: z
          .string()
          .transform(s => s.toUpperCase())
          .pipe(z.string().min(1)),
        handler: async data => ({ processed: data }),
      });

      expect(job.inputSchema.parse('hello')).toBe('HELLO');
    });
  });

  describe('retry configuration', () => {
    it('should accept exponential backoff', () => {
      const job = defineJob({
        name: 'test:exponential',
        inputSchema: z.object({ id: z.string() }),
        handler: async () => ({ success: true }),
        options: {
          retry: {
            attempts: 5,
            backoff: {
              type: 'exponential',
              delay: 1000,
              base: 2,
            },
          },
        },
      });

      expect(job.options?.retry?.backoff.type).toBe('exponential');
      expect(job.options?.retry?.backoff.delay).toBe(1000);
      if (job.options?.retry?.backoff.type === 'exponential') {
        expect(job.options.retry.backoff.base).toBe(2);
      }
    });

    it('should accept fixed backoff', () => {
      const job = defineJob({
        name: 'test:fixed',
        inputSchema: z.object({ id: z.string() }),
        handler: async () => ({ success: true }),
        options: {
          retry: {
            attempts: 3,
            backoff: {
              type: 'fixed',
              delay: 2000,
            },
          },
        },
      });

      expect(job.options?.retry?.backoff.type).toBe('fixed');
      expect(job.options?.retry?.backoff.delay).toBe(2000);
    });
  });

  describe('type inference', () => {
    it('should infer input type from schema', () => {
      const job = defineJob({
        name: 'test:inference',
        inputSchema: z.object({
          name: z.string(),
          age: z.number(),
        }),
        handler: async data => {
          // TypeScript should infer data as { name: string; age: number }
          const name: string = data.name;
          const age: number = data.age;
          return { name, age };
        },
      });

      expect(job.name).toBe('test:inference');
    });

    it('should allow explicit output type', () => {
      type JobOutput = {
        status: 'success' | 'failure';
        message: string;
      };

      const job = defineJob<{ input: string }, JobOutput>({
        name: 'test:output-type',
        inputSchema: z.object({ input: z.string() }),
        handler: async data => {
          return {
            status: 'success',
            message: `Processed: ${data.input}`,
          };
        },
      });

      expect(job.name).toBe('test:output-type');
    });
  });

  describe('naming conventions', () => {
    it('should accept various naming patterns', () => {
      const patterns = [
        'notifications:send-email',
        'orders:process-payment',
        'users:sync-profile',
        'analytics:generate-report',
      ];

      patterns.forEach(name => {
        const job = defineJob({
          name,
          inputSchema: z.object({}),
          handler: async () => ({}),
        });

        expect(job.name).toBe(name);
      });
    });
  });
});
