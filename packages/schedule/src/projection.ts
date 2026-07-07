import { SCHEDULE_ACTION_META_SCHEMA } from './dot.js';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type ScheduleActionLike = {
  readonly id: string;
  readonly pip: string;
  readonly binding: string;
  readonly direction: 'in' | 'out';
  readonly address?: string;
  readonly metaSchema?: string;
  readonly meta?: JsonObject;
};

type ManifestLike = {
  readonly app: { readonly name: string };
  readonly actions: readonly ScheduleActionLike[];
};

export type ScheduleTableDocument = {
  readonly format: 'schedule-table';
  readonly schedules: readonly {
    readonly id: string;
    readonly name: string;
    readonly pip: string;
    readonly kind: 'cron' | 'every';
    readonly address: string;
    readonly timezone?: string;
    readonly overlap: string;
    readonly locked: boolean;
  }[];
};

function scheduleName(action: ScheduleActionLike): string {
  return action.id.endsWith('.fire') ? action.id.slice(0, -'.fire'.length) : action.id;
}

export function project(manifest: ManifestLike): ScheduleTableDocument {
  return {
    format: 'schedule-table',
    schedules: manifest.actions
      .filter(action => action.binding === 'schedule' && action.metaSchema === SCHEDULE_ACTION_META_SCHEMA)
      .map(action => ({
        id: action.id,
        name: scheduleName(action),
        pip: action.pip,
        kind: action.meta?.['kind'] === 'cron' ? 'cron' : 'every',
        address: action.address ?? '',
        ...(typeof action.meta?.['timezone'] === 'string' ? { timezone: action.meta['timezone'] } : {}),
        overlap: typeof action.meta?.['overlap'] === 'string' ? action.meta['overlap'] : 'skip',
        locked: action.meta?.['locked'] === true,
      })),
  };
}
