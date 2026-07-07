import type { EmptyShape, Pip } from '@arki/dot/pip';
import { pip } from '@arki/dot/pip';

import type { ScheduleDef } from './index.js';
import { createScheduleRuntime, type KvLike, type ScheduleRuntime } from './runtime.js';

export const SCHEDULE_ACTION_META_SCHEMA = '@arki/schedule/action-meta@1';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export type ScheduleDotAction = {
  readonly id: string;
  readonly binding: 'schedule';
  readonly direction: 'in';
  readonly address: string;
  readonly metaSchema: typeof SCHEDULE_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

export type ScheduleDotOptions = {
  readonly schedules: readonly ScheduleDef[];
  readonly lock?: KvLike;
  readonly jitterMs?: number;
};

function actionForSchedule(schedule: ScheduleDef, locked: boolean): ScheduleDotAction {
  const kind = schedule.cron === undefined ? 'every' : 'cron';
  const address = schedule.cron ?? schedule.every ?? '';
  return {
    id: `${schedule.name}.fire`,
    binding: 'schedule',
    direction: 'in',
    address,
    metaSchema: SCHEDULE_ACTION_META_SCHEMA,
    meta: {
      kind,
      ...(schedule.cron === undefined ? {} : { cron: schedule.cron }),
      ...(schedule.every === undefined ? {} : { every: schedule.every }),
      ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
      overlap: schedule.overlap,
      locked,
    },
  };
}

export function scheduleActions(
  schedules: readonly ScheduleDef[],
  options: { readonly locked?: boolean } = {},
): readonly ScheduleDotAction[] {
  return schedules.map(definition => actionForSchedule(definition, options.locked ?? false));
}

export function schedule(options: ScheduleDotOptions): Pip<EmptyShape, EmptyShape> {
  let runtime: ScheduleRuntime | undefined;

  return pip({
    name: 'schedule',
    version: '0.0.1',
    actions: scheduleActions(options.schedules, { locked: options.lock !== undefined }),
    configure(ctx) {
      ctx.registerProjection({
        format: 'schedule-table',
        binding: 'schedule',
        module: '@arki/schedule/projection',
      });
      ctx.declareProvides('schedule-runtime');
    },
    boot() {
      runtime = createScheduleRuntime(options);
    },
    start() {
      runtime?.start();
    },
    async stop() {
      await runtime?.stop();
    },
    async dispose() {
      await runtime?.stop();
      runtime = undefined;
    },
  });
}

export type { KvLike, ScheduleRuntime } from './runtime.js';
