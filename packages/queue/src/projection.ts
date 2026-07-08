import { QUEUE_ACTION_META_SCHEMA } from './dot.ts';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type QueueActionLike = {
  readonly id: string;
  readonly plugin: string;
  readonly binding: string;
  readonly direction: 'in' | 'out';
  readonly address?: string;
  readonly metaSchema?: string;
  readonly meta?: JsonObject;
};

type ManifestLike = {
  readonly app: { readonly name: string };
  readonly actions: readonly QueueActionLike[];
};

export type QueueTopologyDocument = {
  readonly format: 'queue-topology';
  readonly queues: readonly {
    readonly name: string;
    readonly consumers: readonly { readonly id: string; readonly plugin: string }[];
    readonly producers: readonly { readonly id: string; readonly plugin: string }[];
  }[];
};

type MutableQueueEntry = {
  name: string;
  consumers: { id: string; plugin: string }[];
  producers: { id: string; plugin: string }[];
};

function queueNameFor(action: QueueActionLike): string | null {
  if (action.binding !== 'queue') return null;
  if (action.metaSchema !== QUEUE_ACTION_META_SCHEMA) return null;
  const queue = action.meta?.['queue'];
  return typeof queue === 'string' ? queue : (action.address ?? null);
}

export function project(manifest: ManifestLike): QueueTopologyDocument {
  const queues = new Map<string, MutableQueueEntry>();

  for (const action of manifest.actions) {
    const queueName = queueNameFor(action);
    if (queueName === null) continue;
    const entry = queues.get(queueName) ?? { name: queueName, consumers: [], producers: [] };
    if (action.direction === 'in') {
      entry.consumers.push({ id: action.id, plugin: action.plugin });
    } else {
      entry.producers.push({ id: action.id, plugin: action.plugin });
    }
    queues.set(queueName, entry);
  }

  return {
    format: 'queue-topology',
    queues: [...queues.values()],
  };
}
