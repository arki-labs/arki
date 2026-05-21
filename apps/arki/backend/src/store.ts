import type { Event } from '@event-driven-io/emmett';

import type { Command, DeciderCommandHandler } from '@arki/event-sourcing/command';
import { getEventStore, projections } from '@arki/event-sourcing/store';

import { env } from './env';

const eventStoreWithCleanup = getEventStore(env.DB_URL, {
  projections: projections.inline([]),
});

export const eventStore = eventStoreWithCleanup;

export const handleCommand = async <State, CommandType extends Command, StreamEvent extends Event>(
  handler: ReturnType<typeof DeciderCommandHandler<State, CommandType, StreamEvent>>,
  streamId: string,
  command: CommandType,
) => {
  try {
    return await handler(eventStoreWithCleanup.eventStore, streamId, command);
  } catch (error) {
    console.error(`Error executing command ${command.type}:`, error);
    throw error;
  }
};
