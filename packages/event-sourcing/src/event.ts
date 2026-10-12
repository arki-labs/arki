import type { DefaultRecord } from './types.js';

export type {
  EventsPublisher,
  EventStore,
  ReadEvent,
  ReadEventMetadataWithGlobalPosition,
} from '@event-driven-io/emmett';

export type Event<
  EventType extends string = string,
  EventData extends DefaultRecord = DefaultRecord,
  EventMetaData extends DefaultRecord | undefined = undefined,
> = Readonly<{
  type: EventType;
  data: EventData;
  metadata?: EventMetaData;
  kind?: 'Event';
}>;

export type AnyEvent = Event<any, any, any>;
export type EventTypeOf<T extends Event> = T['type'];
export type EventDataOf<T extends Event> = T['data'];
export type EventMetaDataOf<T extends Event> = T extends {
  metadata: infer M;
}
  ? M
  : undefined;
export type CreateEventType<
  EventType extends string,
  EventData extends DefaultRecord,
  EventMetaData extends DefaultRecord | undefined = undefined,
> = Readonly<
  EventMetaData extends undefined
    ? {
        type: EventType;
        data: EventData;
      }
    : {
        type: EventType;
        data: EventData;
        metadata: EventMetaData;
      }
> & {
  readonly kind?: 'Event';
};
