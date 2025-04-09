import type { Command, DeciderCommandHandler, Event } from '@event-driven-io/emmett'; // Import Command type
import { getInMemoryMessageBus } from '@event-driven-io/emmett'; // Assuming correct import path

// Register command handlers
// NOTE: The handler function returned by DeciderCommandHandler needs the actual
// EventStore instance to run. Emmett's handle method expects a function that takes
// only the command. We need an adapter or a different registration approach.

// === ALTERNATIVE APPROACH ===
// Emmett's handle method seems designed for simple handlers (command) => Promise<void>.
// The DeciderCommandHandler needs the event store.
// Let's assume we create a wrapper or use a custom command bus setup
// that injects the eventStore when handling.
// For now, we'll register a simple mapping.

// Define command handlers map (Command Type -> Handler Function)
// The handler function needs access to EventStore and Stream Name resolution
// Import social command type

import { eventStore } from '../store'; // Assuming store is here

export const messageBus = getInMemoryMessageBus();

// Helper function to create a handler compatible with messageBus.handle
const createCommandHandler = <
  C extends Command,
  State,
  StreamEvent extends Event,
  T extends ReturnType<typeof DeciderCommandHandler<State, C, StreamEvent>>,
>(
  handler: T,
  getStreamNameFn: (cmd: C) => string,
) => {
  return async (command: C) => {
    const streamName = getStreamNameFn(command);

    await handler(eventStore, streamName, command);
  };
};

// Register handlers using the helper
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'LogMovieWatch');
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'LogTvEpisodeWatch');
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'RateContent');
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'SubmitReview');
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'AddToWatchlist');
// messageBus.handle(createCommandHandler(trackingCommandHandler, getTrackingStreamName), 'RemoveFromWatchlist');

// messageBus.handle(createCommandHandler(socialFollowsCommandHandler, getSocialStreamName), 'FollowUser');
// messageBus.handle(createCommandHandler(socialFollowsCommandHandler, getSocialStreamName), 'UnfollowUser');

console.log('Message Bus and Command Handlers Initialized.');

// We will inject `messageBus` (which has the .send method) into the context.
