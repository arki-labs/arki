/**
 * `kurrentEvents`: an event log in KurrentDB (formerly EventStoreDB). It shares no transaction with
 * the app database, so its entities are forwarded: the write commits the row and a `forward` job,
 * and the worker appends the events here afterwards. One entity is one stream, `<kind>-<entityId>`
 * (with `prefix` in front), so KurrentDB's `$ce-<kind>` category streams group a kind.
 */
import type { KurrentDBClient, Position, RecordedEvent } from '@kurrent/kurrentdb-client';
import {
  BACKWARDS,
  END,
  excludeSystemEvents,
  jsonEvent,
  NO_STREAM,
  START,
  streamNameFilter,
  StreamNotFoundError,
  WrongExpectedVersionError,
} from '@kurrent/kurrentdb-client';
import { z } from 'zod';

import { ensure } from '@arki/schema';

import type { EventLogPosition, EventToAppend, ForwardedLog, StoredEvent } from './event-log.js';
import { JournalError } from './errors.js';
import { eventLogPositionSchema, storedEventRowSchema } from './zod.js';

/**
 * Everything of a journal event KurrentDB has no field for, in the event's metadata under
 * `journal`. The type and the data are KurrentDB's own fields; `erasedAt` never applies, because
 * KurrentDB cannot rewrite an event.
 */
const JournalMetadata = z.object({ journal: storedEventRowSchema.omit({ type: true, data: true, erasedAt: true }) });
/** KurrentDB stores JSON event data as an object, an array or a string. */
const KurrentData = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.string()]);

/** A position in `$all`: the commit and prepare positions, as `commit:prepare`. */
const KurrentPosition = z
  .string()
  .regex(/^\d+:\d+$/, 'a position of a kurrentEvents log is "commit:prepare"')
  .transform((text): Position => {
    const at = text.indexOf(':');
    return { commit: BigInt(text.slice(0, at)), prepare: BigInt(text.slice(at + 1)) };
  });

const positionOf = (at: Position): EventLogPosition => ensure(`${at.commit}:${at.prepare}`, eventLogPositionSchema);
const isAfter = (a: Position, b: Position): boolean =>
  a.commit > b.commit || (a.commit === b.commit && a.prepare > b.prepare);

/** Fixed name space of the event UUIDs: the same journal event id always gives the same UUID. */
const UUID_NAMESPACE = Uint8Array.from([107, 14, 77, 28, 159, 42, 78, 85, 138, 19, 92, 125, 33, 144, 228, 59]);

/**
 * KurrentDB takes only UUID event ids, and drops a repeated append by them. A UUIDv5 of the
 * journal id makes a retried append carry the same ids. Web Crypto, so no Node built-in is needed.
 */
async function eventUuid(eventId: string): Promise<string> {
  const name = new TextEncoder().encode(eventId);
  const input = new Uint8Array(UUID_NAMESPACE.length + name.length);
  input.set(UUID_NAMESPACE);
  input.set(name, UUID_NAMESPACE.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', input));
  const hex = Array.from(digest.subarray(0, 16), (byte, index) => {
    // Version 5 in the high nibble of byte 6, the RFC 4122 variant in the top bits of byte 8.
    const stamped =
      index === 6 ? (byte & 0b0000_1111) | 0b0101_0000 : index === 8 ? (byte & 0b0011_1111) | 0b1000_0000 : byte;
    return stamped.toString(16).padStart(2, '0');
  }).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A KurrentDB event back in the journal's shape. */
const storedOf = (event: RecordedEvent): StoredEvent => {
  const { journal } = ensure(event.metadata, JournalMetadata, {
    message: `journal: kurrentEvents: event ${event.id} in ${event.streamId} was not written by the journal`,
  });
  return { ...journal, type: event.type, data: event.data, erasedAt: null };
};

/** A journal event as KurrentDB takes it. */
const toEventData = async (event: EventToAppend) => {
  const { type, data, ...rest } = event;
  return jsonEvent({
    id: await eventUuid(event.id),
    type,
    data: ensure(data, KurrentData, {
      message: `journal: kurrentEvents: event ${event.id} has data KurrentDB cannot store as JSON`,
    }),
    metadata: z.encode(JournalMetadata, { journal: rest }),
  });
};

/**
 * Appends use the stream's expected revision, so one batch is all or nothing and a rival write is
 * refused. `$all` is KurrentDB's commit order, so it is the global order as it is. No `erase`:
 * KurrentDB cannot rewrite an event in place, so `forget` is refused on its entities.
 * `prefix` puts this log's streams under one name, for several apps or tests on one cluster.
 */
export function kurrentEvents(deps: { readonly client: KurrentDBClient; readonly prefix?: string }): ForwardedLog {
  const { client } = deps;
  const prefix = deps.prefix ?? '';
  if (prefix.includes('-'))
    throw new Error(`journal: kurrentEvents: the prefix ${JSON.stringify(prefix)} must not contain "-"`);

  const streamName = (kind: string, entityId: string): string => {
    if (kind.includes('-'))
      throw new JournalError(
        'BAD_DEFINITION',
        kind,
        entityId,
        `kurrentEvents: the stream name is "<kind>-<entityId>", so the entity kind must not contain "-"`,
      );
    return `${prefix}${kind}-${entityId}`;
  };

  /** This log's streams in `$all`: under the prefix, or every stream but KurrentDB's own `$` ones. */
  const ownStreams = prefix === '' ? excludeSystemEvents() : streamNameFilter({ prefixes: [prefix] });

  const top = async (): Promise<Position | null> => {
    for await (const resolved of client.readAll({
      direction: BACKWARDS,
      fromPosition: END,
      maxCount: 1,
      filter: ownStreams,
    }))
      if (resolved.event !== undefined) return resolved.event.position;
    return null;
  };

  const log: ForwardedLog = {
    canJoinTransaction: false,

    stream: async (kind, entityId, filter) => {
      const events: StoredEvent[] = [];
      const limit = filter?.limit ?? Number.POSITIVE_INFINITY;
      const fromRevision = filter?.afterVersion === undefined ? START : BigInt(filter.afterVersion);
      try {
        for await (const resolved of client.readStream(streamName(kind, entityId), { fromRevision })) {
          if (resolved.event === undefined) continue;
          if (filter?.types !== undefined && !filter.types.includes(resolved.event.type)) continue;
          events.push(storedOf(resolved.event));
          if (events.length >= limit) break;
        }
      } catch (error) {
        if (error instanceof StreamNotFoundError) return [];
        throw error;
      }
      return events;
    },

    highestVersion: async (kind, entityId) => {
      try {
        for await (const resolved of client.readStream(streamName(kind, entityId), {
          direction: BACKWARDS,
          fromRevision: END,
          maxCount: 1,
        }))
          if (resolved.event !== undefined) return Number(resolved.event.revision) + 1;
      } catch (error) {
        if (error instanceof StreamNotFoundError) return 0;
        throw error;
      }
      return 0;
    },

    all: {
      /**
       * Reads the top first, then only up to it. `$all` is commit order, so nothing can land
       * behind the top later, and `next` can move to it. KurrentDB starts a read at the position
       * given, so the event at the cursor itself is skipped.
       */
      after: async (position, filter) => {
        const from = position === null ? null : ensure(position, KurrentPosition);
        const last = await top();
        if (last === null) return { events: [], next: position };
        const streams =
          filter.kinds === undefined
            ? ownStreams
            : streamNameFilter({ prefixes: filter.kinds.map(kind => `${prefix}${kind}-`) });
        const events: (StoredEvent & { readonly position: EventLogPosition })[] = [];
        let end: Position | null = null;
        for await (const resolved of client.readAll({ fromPosition: from ?? START, filter: streams })) {
          const event = resolved.event;
          if (event === undefined) continue;
          if (isAfter(event.position, last)) break;
          if (from !== null && !isAfter(event.position, from)) continue;
          if (filter.types !== undefined && !filter.types.includes(event.type)) continue;
          events.push({ ...storedOf(event), position: positionOf(event.position) });
          end = event.position;
          if (events.length === filter.limit) break;
        }
        const next = end !== null && events.length === filter.limit ? positionOf(end) : positionOf(last);
        return { events, next };
      },
      top: async () => {
        const last = await top();
        return last === null ? null : positionOf(last);
      },
    },

    append: async batch => {
      if (batch.events.length === 0) return;
      const name = streamName(batch.kind, batch.entityId);
      const events = await Promise.all(batch.events.map(event => toEventData(event)));
      try {
        // A revision is a version minus one; version 0 is a stream that does not exist yet.
        await client.appendToStream(name, events, {
          streamState: batch.expectedVersion === 0 ? NO_STREAM : BigInt(batch.expectedVersion - 1),
        });
      } catch (error) {
        if (!(error instanceof WrongExpectedVersionError)) throw error;
        // KurrentDB drops a repeat by event id only in some cases, so read back: the same events
        // at those versions are a repeat (a success); anything else there is a rival writer.
        const there = await log.stream(batch.kind, batch.entityId, {
          afterVersion: batch.expectedVersion,
          limit: batch.events.length,
        });
        const repeat = batch.events.every((event, index) => {
          const found = there.at(index);
          return found?.id === event.id && found.version === event.version;
        });
        if (repeat) return;
        throw new JournalError(
          'CONFLICT',
          batch.kind,
          batch.entityId,
          `version ${batch.expectedVersion + 1} is already in the log: another writer appended it first`,
        );
      }
    },
  };
  return log;
}
