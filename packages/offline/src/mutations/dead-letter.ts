/**
 * Dead-letter store — a separate IDB bucket that holds mutations
 * that exhausted all retry attempts.
 *
 * Supports subscribe() so React hooks can re-render on changes.
 */
import { get, set } from 'idb-keyval';
import superjson from 'superjson';

import type { QueuedMutation } from './queue.ts';

export interface DeadLetterEntry {
  mutation: QueuedMutation;
  error: { message: string; name: string };
  deadLetteredAt: number;
}

export interface DeadLetterStore {
  list(): Promise<readonly QueuedMutation[]>;
  add(entry: QueuedMutation, error: Error): Promise<void>;
  remove(id: string): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export function createDeadLetterStore(storageKey: string): DeadLetterStore {
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) {
      listener();
    }
  }

  async function readAll(): Promise<DeadLetterEntry[]> {
    const raw = await get<string>(storageKey);
    if (!raw) return [];
    try {
      return superjson.parse<DeadLetterEntry[]>(raw);
    } catch {
      return [];
    }
  }

  async function writeAll(entries: DeadLetterEntry[]): Promise<void> {
    await set(storageKey, superjson.stringify(entries));
  }

  return {
    async list(): Promise<readonly QueuedMutation[]> {
      const entries = await readAll();
      return entries.map((e) => e.mutation);
    },

    async add(mutation: QueuedMutation, error: Error): Promise<void> {
      const entries = await readAll();
      const entry: DeadLetterEntry = {
        mutation,
        error: { message: error.message, name: error.name },
        deadLetteredAt: Date.now(),
      };
      await writeAll([...entries, entry]);
      notify();
    },

    async remove(id: string): Promise<void> {
      const entries = await readAll();
      await writeAll(entries.filter((e) => e.mutation.id !== id));
      notify();
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
