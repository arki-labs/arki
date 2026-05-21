/**
 * Event Sourcing Builders
 *
 * Fluent API builders for constructing event sourcing components with type safety.
 *
 * @example
 * ```typescript
 * import { defineEvent, defineDecider, defineProjection } from '@arki/event-sourcing/builders';
 *
 * // Define an event
 * const userCreated = defineEvent()
 *   .type('UserCreated')
 *   .data(z.object({ userId: z.string(), email: z.string() }))
 *   .metadata(z.object({ timestamp: z.string() }))
 *   .handler(({ data, metadata }) => ({ type: 'UserCreated', data, metadata }));
 *
 * // Define a decider
 * const userDecider = defineDecider()
 *   .stateSchema(userStateSchema)
 *   .initialState(() => ({ users: [] }))
 *   .evolve((state, event) => { ... })
 *   .decide((command, state) => { ... })
 *   .handler();
 *
 * // Define a projection
 * const userProjection = defineProjection()
 *   .name('user-projection')
 *   .eventTypes(['UserCreated', 'UserUpdated'])
 *   .contextSchema(z.object({ repo: z.any() }))
 *   .handler(async (events, context) => { ... });
 * ```
 */

export { defineCommand } from './command.js';
export { defineCommandHandler, type CommandHandler } from './command-handler.js';
export { defineEvent } from './event.js';
export { defineDecider } from './decider.js';
export { defineProjection } from './projection.js';
export { defineProcessManager } from './process-manager.js';
export { defineStatefulProcessManager } from './stateful-process-manager.js';
