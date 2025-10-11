import { describe, expect, it } from 'vitest';
import { z } from 'zod/v4';

import { defineSchedule } from './define-schedule';

describe('defineSchedule', () => {
  describe('cron-based schedules', () => {
    it('should create a cron schedule with required fields', () => {
      const schedule = defineSchedule({
        name: 'test:daily-task',
        schedule: {
          type: 'cron',
          pattern: '0 2 * * *',
        },
        schema: z.object({}),
        handler: async () => ({ completed: true }),
      });

      expect(schedule.name).toBe('test:daily-task');
      expect(schedule.schedule.type).toBe('cron');
      if (schedule.schedule.type === 'cron') {
        expect(schedule.schedule.pattern).toBe('0 2 * * *');
        expect(schedule.schedule.timezone).toBeUndefined();
      }
    });

    it('should create a cron schedule with timezone', () => {
      const schedule = defineSchedule({
        name: 'test:timezone-task',
        schedule: {
          type: 'cron',
          pattern: '0 9 * * *',
          timezone: 'America/New_York',
        },
        schema: z.object({}),
        handler: async () => ({ completed: true }),
      });

      if (schedule.schedule.type === 'cron') {
        expect(schedule.schedule.timezone).toBe('America/New_York');
      }
    });

    it('should accept various cron patterns', () => {
      const patterns = [
        '0 * * * *', // Every hour
        '*/15 * * * *', // Every 15 minutes
        '0 0 * * 0', // Every Sunday at midnight
        '0 0 1 * *', // First day of every month
        '0 0 1 1 *', // January 1st every year
      ];

      patterns.forEach(pattern => {
        const schedule = defineSchedule({
          name: `test:cron-${pattern}`,
          schedule: {
            type: 'cron',
            pattern,
          },
          schema: z.object({}),
          handler: async () => ({}),
        });

        if (schedule.schedule.type === 'cron') {
          expect(schedule.schedule.pattern).toBe(pattern);
        }
      });
    });
  });

  describe('interval-based schedules', () => {
    it('should create an interval schedule', () => {
      const schedule = defineSchedule({
        name: 'test:every-minute',
        schedule: {
          type: 'interval',
          milliseconds: 60000,
        },
        schema: z.object({}),
        handler: async () => ({ completed: true }),
      });

      expect(schedule.schedule.type).toBe('interval');
      if (schedule.schedule.type === 'interval') {
        expect(schedule.schedule.milliseconds).toBe(60000);
      }
    });

    it('should accept various interval durations', () => {
      const intervals = [
        { name: 'every-second', ms: 1000 },
        { name: 'every-30-seconds', ms: 30000 },
        { name: 'every-5-minutes', ms: 5 * 60 * 1000 },
        { name: 'every-hour', ms: 60 * 60 * 1000 },
        { name: 'every-day', ms: 24 * 60 * 60 * 1000 },
      ];

      intervals.forEach(({ name, ms }) => {
        const schedule = defineSchedule({
          name: `test:${name}`,
          schedule: {
            type: 'interval',
            milliseconds: ms,
          },
          schema: z.object({}),
          handler: async () => ({}),
        });

        if (schedule.schedule.type === 'interval') {
          expect(schedule.schedule.milliseconds).toBe(ms);
        }
      });
    });
  });

  describe('handler function', () => {
    it('should execute handler correctly', async () => {
      const schedule = defineSchedule({
        name: 'test:handler',
        schedule: {
          type: 'interval',
          milliseconds: 60000,
        },
        schema: z.object({
          taskId: z.string(),
        }),
        handler: async data => {
          return { taskId: data.taskId, executedAt: new Date().toISOString() };
        },
      });

      const mockContext = {
        updateProgress: async () => {},
        log: async () => {},
        job: {} as any,
      };

      const result = await schedule.handler({ taskId: 'task_123' }, mockContext);
      expect(result.taskId).toBe('task_123');
      expect(result.executedAt).toBeDefined();
    });

    it('should allow handler to use context', async () => {
      const logs: string[] = [];

      const schedule = defineSchedule({
        name: 'test:context',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({}),
        handler: async (data, ctx) => {
          await ctx.log('Starting scheduled task');
          await ctx.updateProgress(50);
          await ctx.log('Task completed');
          await ctx.updateProgress(100);
          return { success: true };
        },
      });

      const mockContext = {
        updateProgress: async () => {},
        log: async (msg: string) => {
          logs.push(msg);
        },
        job: {} as any,
      };

      await schedule.handler({}, mockContext);
      expect(logs).toEqual(['Starting scheduled task', 'Task completed']);
    });
  });

  describe('options', () => {
    it('should accept default data', () => {
      const defaultData = {
        dryRun: false,
        maxItems: 100,
      };

      const schedule = defineSchedule({
        name: 'test:default-data',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({
          dryRun: z.boolean(),
          maxItems: z.number(),
        }),
        handler: async data => ({ processed: data.maxItems }),
        options: {
          defaultData,
        },
      });

      expect(schedule.options?.defaultData).toEqual(defaultData);
    });

    it('should accept job options', () => {
      const onCompleteMock = async () => {
        /* no-op */
      };

      const schedule = defineSchedule({
        name: 'test:job-options',
        schedule: {
          type: 'interval',
          milliseconds: 30000,
        },
        schema: z.object({}),
        handler: async () => ({ completed: true }),
        options: {
          jobOptions: {
            maxParallelism: 1,
            retry: {
              attempts: 2,
              backoff: {
                type: 'fixed',
                delay: 1000,
              },
            },
            onComplete: onCompleteMock,
          },
        },
      });

      expect(schedule.options?.jobOptions?.maxParallelism).toBe(1);
      expect(schedule.options?.jobOptions?.retry?.attempts).toBe(2);
      expect(schedule.options?.jobOptions?.onComplete).toBe(onCompleteMock);
    });
  });

  describe('schema validation', () => {
    it('should work with empty schema', () => {
      const schedule = defineSchedule({
        name: 'test:empty-schema',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({}),
        handler: async () => ({ success: true }),
      });

      expect(schedule.schema.parse({})).toEqual({});
    });

    it('should work with complex schema', () => {
      const schedule = defineSchedule({
        name: 'test:complex-schema',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({
          options: z.object({
            batchSize: z.number().min(1).max(1000),
            dryRun: z.boolean().default(false),
          }),
          filters: z.array(z.string()).optional(),
        }),
        handler: async data => ({ processed: data.options.batchSize }),
      });

      const validData = {
        options: {
          batchSize: 100,
          dryRun: true,
        },
        filters: ['active', 'verified'],
      };

      expect(schedule.schema.parse(validData)).toEqual(validData);
    });

    it('should work with default values', () => {
      const schedule = defineSchedule({
        name: 'test:defaults',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({
          enabled: z.boolean().default(true),
          maxRetries: z.number().default(3),
        }),
        handler: async data => ({ enabled: data.enabled }),
      });

      const parsed = schedule.schema.parse({});
      expect(parsed.enabled).toBe(true);
      expect(parsed.maxRetries).toBe(3);
    });
  });

  describe('naming conventions', () => {
    it('should accept various naming patterns', () => {
      const names = [
        'maintenance:daily-cleanup',
        'reports:weekly-summary',
        'notifications:send-reminders',
        'analytics:aggregate-data',
      ];

      names.forEach(name => {
        const schedule = defineSchedule({
          name,
          schedule: {
            type: 'cron',
            pattern: '0 0 * * *',
          },
          schema: z.object({}),
          handler: async () => ({}),
        });

        expect(schedule.name).toBe(name);
      });
    });
  });

  describe('type inference', () => {
    it('should infer input type from schema', () => {
      const schedule = defineSchedule({
        name: 'test:inference',
        schedule: {
          type: 'cron',
          pattern: '0 0 * * *',
        },
        schema: z.object({
          targetDate: z.string(),
          includeArchived: z.boolean(),
        }),
        handler: async data => {
          // TypeScript should infer data correctly
          const date: string = data.targetDate;
          const include: boolean = data.includeArchived;
          return { date, include };
        },
      });

      expect(schedule.name).toBe('test:inference');
    });

    it('should allow explicit output type', () => {
      type ScheduleOutput = {
        itemsProcessed: number;
        duration: number;
      };

      const schedule = defineSchedule<{ batchSize: number }, ScheduleOutput>({
        name: 'test:output-type',
        schedule: {
          type: 'interval',
          milliseconds: 60000,
        },
        schema: z.object({
          batchSize: z.number(),
        }),
        handler: async data => {
          return {
            itemsProcessed: data.batchSize,
            duration: 1500,
          };
        },
      });

      expect(schedule.name).toBe('test:output-type');
    });
  });
});
