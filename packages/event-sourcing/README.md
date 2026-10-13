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
- **DOT adapter** — `eventSourcing()` opens the store, publishes `eventStore` + `messageBus`, collects feature-local ES bundles, and registers the `event-catalog` projection.
- **Process managers** — `createProcessManager` (per-batch), `createStatefulProcessManager` (per-batch with state), and `createSimpleProcessManager` (per-message with a pre-bound context).
- **Builders** — `defineCommand`, `defineEvent`, `defineDecider`, `defineProjection`, `defineCommandHandler`, `defineProcessManager`, `defineStatefulProcessManager` for type-safe authoring.
- **Drizzle projection helpers** — `drizzleProjection` / `drizzleWithRepoProjection` so projection handlers receive a typed Drizzle database (or repository registry) instead of a raw client.

## Quick start

### DOT app setup

```ts
import { z } from '@arki/contracts';
import { defineApp, plugin, provide, token } from '@arki/dot';
import { eventSourcing, es, type EsBundle } from '@arki/event-sourcing/dot';
import { defineCommand, defineCommandHandler, defineEvent } from '@arki/event-sourcing/builders';

const placeOrder = defineCommand({
  type: 'PlaceOrder',
  inputSchema: z.object({ orderId: z.string(), total: z.number() }),
});

const orderPlaced = defineEvent({
  type: 'OrderPlaced',
  dataSchema: z.object({ orderId: z.string(), total: z.number() }),
});

const placeOrderHandler = defineCommandHandler({
  initialState: () => ({ placed: false }),
  evolve: (state, event) => (event.type === 'OrderPlaced' ? { placed: true } : state),
  decide: (command, state) => {
    if (state.placed) throw new Error('Order already placed');
    return [orderPlaced({ orderId: command.data.orderId, total: command.data.total })];
  },
});

export const OrdersEs = token<EsBundle>()('orders.es');

export const ordersEsPlugin = plugin({
  name: 'orders-es',
  actions: [placeOrder, orderPlaced],
  boot: () =>
    provide(
      OrdersEs,
      es.bundle({
        handlers: [es.handle(placeOrder, placeOrderHandler, command => `order-${command.data.orderId}`)],
        readModels: [],
      }),
    ),
});

export const app = defineApp('shop-api')
  .use(ordersEsPlugin)
  .use(eventSourcing({ bundles: [OrdersEs], dbUrl: process.env.DB_URL }));
```

`eventSourcing()` may be mounted with no options for append-only mode. It resolves the store URL from `EVENT_STORE_URL`, `EVENTSTORE_URL`, or `EVENT_DB_URL`; apps that use a different env name should pass `dbUrl` explicitly.

Commands and events produced by `defineCommand` / `defineEvent` contribute DOT actions. `dot explain --as event-catalog` renders their JSON Schemas without booting the app. Deprecated dynamic `commandHandlers` still run, but are intentionally absent from the manifest and catalog.

### Composition order

Feature plugins that handle commands publish ES bundles. Feature plugins that send commands need the `messageBus` service. Mount them in this order:

```text
es-feature plugins -> eventSourcing() -> http/queue feature plugins that need messageBus -> http()/queue runtime
```

A feature that both handles `PlaceOrder` and exposes `POST /orders` should be split into two plugins: `orders-es` publishes `OrdersEs`; `orders-http` needs `messageBus` and binds the HTTP route.

### HTTP and queue recipes

Expose a command over HTTP explicitly:

```ts
routes().bind(placeOrderRoute, async ({ body }, { messageBus }) => {
  await messageBus.send(placeOrder(body));
  return { ok: true };
});
```

Use `@arki/queue` for durable/async command transport:

```ts
jobs.worker('orders.place', async ({ payload }, { messageBus }) => {
  await messageBus.send(placeOrder(payload));
});
```

The message bus published by this package is strictly in-process synchronous dispatch. It is not durable, does not distribute work across instances, and does not survive restarts or rolling deploys.

### Programmatic bootstrap

Non-DOT composition roots can still use the lower-level helpers:

```ts
import { eventSourcingFeatures } from '@arki/event-sourcing';

const { eventStore, close } = eventSourcingFeatures.initEventSourcing(
  [
    /* read-model projections produced by defineProjection / drizzleProjection / postgreSQLProjection */
  ],
  process.env.EVENT_STORE_URL,
);

const messageBus = eventSourcingFeatures.initMessageBus(eventStore, [
  /* { commandType, handler, getStreamName } registrations */
]);

await close();
```

### Process managers

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
- `@arki/event-sourcing/dot` — DOT plugin, ES bundle helpers, and ES plugin error codes.
- `@arki/event-sourcing/projection` — pure `event-catalog` projection for DOT.

## Documentation

For an overview of the package's design principles, see [`docs/design.md`](./docs/design.md). For command flow patterns, see [`docs/command-flows.md`](./docs/command-flows.md).

## License

MIT © ARKI Contributors
