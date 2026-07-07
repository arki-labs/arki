# @arki/event-sourcing

Event sourcing primitives for the ARKI package family — event store, message bus, command handlers, projections, and process managers, built on top of [Emmett](https://event-driven-io.github.io/emmett/) with `@event-driven-io/emmett-postgresql`.

## Installation

```sh
npm install @arki/event-sourcing
# or
bun add @arki/event-sourcing
# or
pnpm add @arki/event-sourcing
```

Peer-installs:

- `@event-driven-io/emmett` (re-exported core types)
- `@event-driven-io/emmett-postgresql` (PostgreSQL event store)
- `drizzle-orm` (for projections that write through a Drizzle handle)

## What you get

- **Event store** — `getEventStore(connectionString, options)` opens a PostgreSQL event store with a clean `close()` that releases the pool.
- **Message bus** — `eventSourcingFeatures.initMessageBus(eventStore, handlers)` builds an in-memory message bus, registers command handlers, and wraps each handler with stream-name resolution + logging.
- **Process managers** — `createProcessManager` (per-batch), `createStatefulProcessManager` (per-batch with state), and `createSimpleProcessManager` (per-message with a pre-bound context).
- **Builders** — fluent `defineCommand`, `defineEvent`, `defineDecider`, `defineProjection`, `defineCommandHandler`, `defineProcessManager`, `defineStatefulProcessManager` for type-safe authoring.
- **Drizzle projection helpers** — `drizzleProjection` / `drizzleWithRepoProjection` so projection handlers receive a typed Drizzle database (or repository registry) instead of a raw client.

## Quick start

### 1. Bootstrap an event store and message bus

```ts
import { eventSourcingFeatures } from '@arki/event-sourcing';

const { eventStore, close } = eventSourcingFeatures.initEventSourcing(
  [
    /* projections produced by defineProjection / drizzleProjection / postgreSQLProjection */
  ],
  process.env.EVENT_STORE_URL,
);

const messageBus = eventSourcingFeatures.initMessageBus(eventStore, [
  /* { commandType, handler, getStreamName } registrations */
]);

// Later, on shutdown:
await close();
```

`initEventSourcing` throws a descriptive error if the connection string is undefined, naming `EVENT_STORE_URL`, `EVENTSTORE_URL`, and `EVENT_DB_URL` as the recognised env var names.

### 2. Define a command, a decider, and a handler

```ts
import { defineCommand, defineEvent, defineDecider, defineCommandHandler, z } from '@arki/event-sourcing';
// (or import each builder from '@arki/event-sourcing/builders')

const PlaceOrder = defineCommand({
  type: 'PlaceOrder',
  inputSchema: z.object({ orderId: z.string(), total: z.number() }),
  metadataSchema: z.object({ userId: z.string() }),
});

const OrderPlaced = defineEvent({
  type: 'OrderPlaced',
  inputSchema: z.object({ orderId: z.string(), total: z.number() }),
  metadataSchema: z.object({ userId: z.string(), at: z.string() }),
});

const orderDecider = defineDecider()
  .initialState(() => ({ placed: false }))
  .evolve((state, event) => (event.type === 'OrderPlaced' ? { placed: true } : state))
  .decide((command, state) => {
    if (state.placed) throw new Error('Order already placed');
    return OrderPlaced({ orderId: command.data.orderId, total: command.data.total }, {
      userId: command.metadata.userId,
      at: new Date().toISOString(),
    });
  })
  .build();

export const placeOrderHandler = defineCommandHandler(orderDecider);
```

### 3. Define a process manager

Use `createProcessManager` for batch processing, or `createSimpleProcessManager` when the handler closes over a fixed context and processes one event at a time:

```ts
import { createSimpleProcessManager } from '@arki/event-sourcing';

const sendOrderEmails = createSimpleProcessManager(
  { emailer, repo },
  'order-emails',
  ['OrderPlaced', 'OrderCancelled'],
  async (event, ctx) => {
    if (event.type === 'OrderPlaced') {
      await ctx.emailer.send('order-placed', event.data);
    } else {
      await ctx.emailer.send('order-cancelled', event.data);
    }
  },
);

await eventSourcingFeatures.setupProcessManagers(eventStore, [sendOrderEmails]);
```

`setupProcessManagers` starts each process manager as a consumer of the event store and installs a SIGTERM hook that stops and closes the consumers before exiting.

## Subpath exports

- `@arki/event-sourcing` — main surface (commands, events, deciders, process managers, features).
- `@arki/event-sourcing/builders` — fluent builders only.
- `@arki/event-sourcing/store` — `getEventStore`, `drizzleProjection`, `postgreSQLProjection`, projection context types.
- `@arki/event-sourcing/bus` — `getInMemoryMessageBus` and message bus types re-exported from Emmett.

## Documentation

For an overview of the package's design principles, see [`docs/design.md`](./docs/design.md). For command flow patterns, see [`docs/command-flows.md`](./docs/command-flows.md).

## License

MIT © ARKI Contributors
