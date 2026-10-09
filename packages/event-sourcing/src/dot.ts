/**
 * DOT adapter for `@arki/event-sourcing`.
 *
 * Wraps `eventSourcingFeatures.initEventSourcing` + `initMessageBus` as a
 * single `DotPlugin`. The plugin opens the PostgreSQL event store in
 * `boot`, attaches command handlers to an in-memory message bus, publishes
 * both as `services.eventStore` and `services.messageBus`, and closes the
 * event store pool in `dispose` (reverse declaration order).
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 * import { eventSourcing } from '@arki/event-sourcing/dot';
 *
 * const app = await defineApp('my-app')
 *   .use(eventSourcing({
 *     projections: [orderProjection, invoiceProjection],
 *     commandHandlers: [placeOrderHandler, cancelOrderHandler],
 *   }))
 *   .boot();
 *
 * await app.services.messageBus.send({ type: 'PlaceOrder', payload: { ... } });
 * await app.dispose();
 * ```
 *
 * The connection URL is resolved in this order:
 *   1. `options.dbUrl` if provided
 *   2. `process.env.EVENT_STORE_URL`
 *   3. `process.env.EVENTSTORE_URL`
 *   4. `process.env.EVENT_DB_URL`
 *
 * If none are set, `boot` throws with a message naming every accepted env
 * var — same contract as `eventSourcingFeatures.initEventSourcing`.
 *
 * The `@arki/dot` package is an OPTIONAL peer of `@arki/event-sourcing`.
 * Importing this adapter without `@arki/dot` installed will fail at module
 * load — that is intentional: the adapter only makes sense in a DOT app.
 */

import type { Command, Event, EventStore, MessageBus } from '@event-driven-io/emmett';

import type { EmptyShape, Plugin, Token } from '@arki/dot/plugin';
import { plugin, DotPluginError } from '@arki/dot/plugin';

import type { CommandHandlerRegistration } from './command.js';
import { debugBuilder } from './debug.js';
import type { PostgreSQLProjectionInput } from './event-sourcing-features.js';
import { EVENT_STORE_URL_VARIANTS, eventSourcingFeatures } from './event-sourcing-features.js';
import type { CommandHandler } from './builders/command-handler.js';

/**
 * Stable error codes thrown by the event-sourcing plugin. Exported so consumers
 * and coding agents can match against them — never parse the message.
 *
 * @see packages/dot/docs/principles.md — principle 1.3 ("errors are part
 * of the API") and principle 4 ("agent-discoverable everywhere").
 */
export const EVENT_SOURCING_PLUGIN_ERROR_CODES = {
  /** boot was called without a configured event-store URL. */
  dbUrlNotConfigured: 'EVENT_SOURCING_PLUGIN_E001',
  /** two collected handlers claim the same command type. */
  duplicateCommandHandler: 'EVENT_SOURCING_PLUGIN_E002',
  /** a bundle token listed in options.bundles was not provided. */
  bundleMissing: 'EVENT_SOURCING_PLUGIN_E003',
  /** a command was dispatched with no registered handler. */
  commandHandlerMissing: 'EVENT_SOURCING_PLUGIN_E004',
  /** a command was dispatched after the dispatcher closed. */
  dispatcherClosed: 'EVENT_SOURCING_PLUGIN_E005',
  /** reserved for a future declared-action/handler parity diagnostic. */
  declaredActionUnbound: 'EVENT_SOURCING_PLUGIN_E006',
  /** command/event schema could not be converted to JSON Schema. */
  schemaRejected: 'EVENT_SOURCING_PLUGIN_E007',
} as const;

const EVENT_SOURCING_PLUGIN_VERSION = '0.2.0';

/** A token publishing an {@link EsBundle} — what `options.bundles` lists. */
export type BundleToken = Token<EsBundle, string>;

/** Wire-needs record derived from bundle tokens. */
export type BundleNeeds<TBundles extends readonly BundleToken[]> = {
  readonly [Tok in TBundles[number] as Tok extends Token<EsBundle, infer K> ? K : never]: EsBundle;
};

/**
 * A feature token whose slice MAY carry an ES bundle under the `es` key —
 * what `options.features` lists (the feature-plugins slice protocol).
 * Features without an `es` slice contribute nothing, by design.
 */
export type EsFeatureToken = Token<{ readonly es?: EsBundle }, string>;

/** Wire-needs record derived from feature tokens. */
export type EsFeatureNeeds<TFeatures extends readonly EsFeatureToken[]> = {
  readonly [Tok in TFeatures[number] as Tok extends Token<unknown, infer K> ? K : never]: {
    readonly es?: EsBundle;
  };
};

type CommandFactory<C extends Command = Command> = {
  readonly type: C['type'];
} & ((input: never, metadata?: never) => C);

/** Feature-local event-sourcing registrations collected by `eventSourcing()`. */
export type EsBundle = {
  /** Command handlers attached to the in-process message bus at boot. */
  readonly handlers: readonly CommandHandlerRegistration[];
  /** Inline PostgreSQL read-model projections registered on the event store. */
  readonly readModels: readonly PostgreSQLProjectionInput[];
};

export type EsBundleInput = {
  readonly handlers?: readonly CommandHandlerRegistration[];
  readonly readModels?: readonly PostgreSQLProjectionInput[];
};

function bundle(input: EsBundleInput = {}): EsBundle {
  return {
    handlers: input.handlers ?? [],
    readModels: input.readModels ?? [],
  };
}

function handle<C extends Command, State, StreamEvent extends Event>(
  command: CommandFactory<C>,
  handler: CommandHandler<State, C, StreamEvent>,
  getStreamName: (command: C) => string,
): CommandHandlerRegistration<C, State, StreamEvent> {
  return {
    commandType: command.type,
    handler,
    getStreamName,
  };
}

/** Namespace for feature-local ES bundle helpers. */
export const es = {
  bundle,
  handle,
};

/**
 * Options for the event-sourcing DOT adapter.
 */
export type EventSourcingDotOptions<
  TBundles extends readonly BundleToken[] = readonly BundleToken[],
  TFeatures extends readonly EsFeatureToken[] = readonly EsFeatureToken[],
> = {
  /**
   * PostgreSQL projection definitions registered inline on the event store.
   * Accepts the three projection builder patterns documented on
   * {@link PostgreSQLProjectionInput}.
   */
  readonly projections?: readonly PostgreSQLProjectionInput[];
  /**
   * Feature-local bundles to collect. Each token becomes a typed DOT need,
   * so the app builder rejects an `eventSourcing({ bundles })` collector
   * unless an earlier plugin publishes every listed bundle.
   */
  readonly bundles?: TBundles;
  /**
   * Feature-plugin slice tokens to collect (`{ es?: EsBundle }`). Each token
   * becomes a typed DOT need like `bundles`; a feature without an `es`
   * slice contributes nothing (partial features are zero-config — a
   * debug line records the empty contribution).
   */
  readonly features?: TFeatures;
  /**
   * Command handlers wired into the in-memory message bus. Each handler's
   * `getStreamName` callback maps an incoming command to its target stream.
   *
   * Defaults to `[]` — useful when an app only does projections / event
   * appends without command-side dispatch.
   */
  readonly commandHandlers?: readonly CommandHandlerRegistration[];
  /**
   * Connection URL for the event store. When omitted, the plugin reads
   * `EVENT_STORE_URL`, `EVENTSTORE_URL`, or `EVENT_DB_URL` from
   * `process.env`. If none are set, `boot` throws.
   */
  readonly dbUrl?: string;
};

/** Services published by the event-sourcing adapter. */
export type EventSourcingServices = {
  /** The Emmett event store handle, ready to load/append streams. */
  readonly eventStore: EventStore;
  /**
   * The in-memory message bus. Already has the configured command handlers
   * attached — call `messageBus.send(command)` to dispatch.
   */
  readonly messageBus: MessageBus;
};

type ControlledMessageBus = MessageBus & {
  close(): Promise<void>;
};

/**
 * Resolve the event-store connection URL from explicit options first, then
 * from the recognised env vars in priority order. Returns `undefined` when
 * none are set so the underlying factory can throw the canonical error.
 */
function resolveDbUrl(explicit: string | undefined): string | undefined {
  if (explicit !== undefined && explicit !== '') return explicit;
  for (const name of EVENT_STORE_URL_VARIANTS) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function dotPluginError(args: {
  code: (typeof EVENT_SOURCING_PLUGIN_ERROR_CODES)[keyof typeof EVENT_SOURCING_PLUGIN_ERROR_CODES];
  message: string;
  remediation: string;
  docsSlug: string;
}): DotPluginError {
  return new DotPluginError({
    code: args.code,
    message: args.message,
    remediation: args.remediation,
    docsUrl: `https://arki.dev/event-sourcing/errors/${args.docsSlug}`,
  });
}

function assertUniqueCommandHandlers(commandHandlers: readonly CommandHandlerRegistration[]): void {
  const seen = new Map<string, number>();
  for (const registration of commandHandlers) {
    const count = seen.get(registration.commandType) ?? 0;
    seen.set(registration.commandType, count + 1);
  }
  const duplicate = [...seen.entries()].find(([, count]) => count > 1)?.[0];
  if (duplicate === undefined) return;

  throw dotPluginError({
    code: EVENT_SOURCING_PLUGIN_ERROR_CODES.duplicateCommandHandler,
    message: `[event-sourcing] command handler "${duplicate}" is registered more than once.`,
    remediation:
      'Each command type may have exactly one handler across options.bundles and dynamic commandHandlers. Remove one registration or rename the command type.',
    docsSlug: 'event-sourcing-plugin-e002',
  });
}

function controlledMessageBus(inner: MessageBus, commandTypes: ReadonlySet<string>): ControlledMessageBus {
  let closed = false;
  let inflight = 0;
  const waiters: (() => void)[] = [];

  const finishOne = (): void => {
    inflight -= 1;
    if (inflight !== 0) return;
    const drained = waiters.splice(0);
    for (const waiter of drained) waiter();
  };

  return {
    async send(command) {
      if (closed) {
        throw dotPluginError({
          code: EVENT_SOURCING_PLUGIN_ERROR_CODES.dispatcherClosed,
          message: `[event-sourcing] command "${command.type}" was dispatched after the message bus closed.`,
          remediation:
            'Do not send commands after app.stop() begins. Stop ingress before closing event-sourcing consumers.',
          docsSlug: 'event-sourcing-plugin-e005',
        });
      }
      if (!commandTypes.has(command.type)) {
        throw dotPluginError({
          code: EVENT_SOURCING_PLUGIN_ERROR_CODES.commandHandlerMissing,
          message: `[event-sourcing] no command handler is registered for "${command.type}".`,
          remediation:
            'Declare a feature ES bundle with es.handle(...), publish it before eventSourcing(...), and list its token in options.bundles.',
          docsSlug: 'event-sourcing-plugin-e004',
        });
      }

      inflight += 1;
      try {
        await inner.send(command);
      } finally {
        finishOne();
      }
    },
    publish: event => inner.publish(event),
    schedule: (message, when) => {
      inner.schedule(message, when);
    },
    close() {
      closed = true;
      if (inflight === 0) return Promise.resolve();
      return new Promise(resolve => {
        waiters.push(resolve);
      });
    },
  };
}

/**
 * Build a DOT plugin that opens the event store, wires command handlers
 * into an in-memory message bus, and publishes both as services. The
 * kernel calls `dispose` in reverse declaration order to release the
 * underlying PG pool.
 */
export function eventSourcing<
  const TBundles extends readonly BundleToken[] = readonly [],
  const TFeatures extends readonly EsFeatureToken[] = readonly [],
>(
  options: EventSourcingDotOptions<TBundles, TFeatures> = {},
): Plugin<BundleNeeds<TBundles> & EsFeatureNeeds<TFeatures>, EventSourcingServices> {
  const bundleTokens = options.bundles ?? [];
  const featureTokens = options.features ?? [];
  const needs: Record<string, BundleToken | EsFeatureToken> = {};
  for (const tok of [...bundleTokens, ...featureTokens]) {
    if (needs[tok.key] !== undefined) {
      throw dotPluginError({
        code: EVENT_SOURCING_PLUGIN_ERROR_CODES.duplicateCommandHandler,
        message: `[event-sourcing] token "${tok.key}" is listed twice across options.bundles/options.features.`,
        remediation: 'List each ES bundle or feature token once.',
        docsSlug: 'event-sourcing-plugin-e002',
      });
    }
    needs[tok.key] = tok;
  }

  // Captured at boot so dispose can call it without re-reading services
  // (dispose is allowed to run even when services failed to publish).
  let closeStore: (() => Promise<void>) | undefined;
  let closeBus: (() => Promise<void>) | undefined;

  const inner = plugin<EmptyShape, EventSourcingServices>({
    name: 'event-sourcing',
    version: EVENT_SOURCING_PLUGIN_VERSION,
    needs,
    configure(ctx) {
      ctx.registerService('eventStore', 'event-store');
      ctx.registerService('messageBus', 'message-bus');
      ctx.registerProjection({
        format: 'event-catalog',
        binding: 'es',
        module: '@arki/event-sourcing/projection',
      });
      ctx.declareProvides('event-store', 'message-bus');
    },
    boot(ctx): EventSourcingServices {
      // Validate at the plugin boundary so the DOT lifecycle gets a coded
      // error. `eventSourcingFeatures.initEventSourcing` still throws raw
      // `Error` for non-DOT consumers (its public contract is unchanged);
      // the check here makes sure we never reach it without a URL.
      const dbUrl = resolveDbUrl(options.dbUrl);
      if (dbUrl === undefined) {
        throw new DotPluginError({
          code: EVENT_SOURCING_PLUGIN_ERROR_CODES.dbUrlNotConfigured,
          message: '[event-sourcing] Event Store database URL is not configured.',
          remediation: `Pass options.dbUrl to eventSourcing(...) or set one of ${EVENT_STORE_URL_VARIANTS.join(
            ', ',
          )} in the environment before booting the app.`,
          docsUrl: 'https://arki.dev/dot/errors/event-sourcing-plugin-e001',
        });
      }

      const record = ctx as unknown as Readonly<Record<string, EsBundle | undefined>>;
      const bundles: EsBundle[] = [];
      for (const tok of bundleTokens) {
        const collected = record[tok.key];
        if (collected === undefined) {
          throw dotPluginError({
            code: EVENT_SOURCING_PLUGIN_ERROR_CODES.bundleMissing,
            message: `[event-sourcing] bundle "${tok.key}" was not provided by any earlier plugin.`,
            remediation:
              'Mount the plugin that publishes this ES bundle before eventSourcing(...). The typed builder enforces this; erased composition reaches this check.',
            docsSlug: 'event-sourcing-plugin-e003',
          });
        }
        bundles.push(collected);
      }

      const featureRecord = ctx as unknown as Readonly<Record<string, { readonly es?: EsBundle } | undefined>>;
      for (const tok of featureTokens) {
        const slice = featureRecord[tok.key];
        if (slice === undefined) {
          throw dotPluginError({
            code: EVENT_SOURCING_PLUGIN_ERROR_CODES.bundleMissing,
            message: `[event-sourcing] feature "${tok.key}" was not provided by any earlier plugin.`,
            remediation:
              'Mount the feature plugin that provides this token before eventSourcing(...). The typed builder enforces this; erased composition reaches this check.',
            docsSlug: 'event-sourcing-plugin-e003',
          });
        }
        if (slice.es === undefined) {
          debugBuilder('[event-sourcing] feature "%s" did not contribute an es slice.', tok.key);
          continue;
        }
        bundles.push(slice.es);
      }

      const readModels = [
        ...(options.projections ?? []),
        ...bundles.flatMap(collected => collected.readModels),
      ];
      const commandHandlers = [
        ...bundles.flatMap(collected => collected.handlers),
        ...(options.commandHandlers ?? []),
      ];
      assertUniqueCommandHandlers(commandHandlers);

      const { eventStore, close } = eventSourcingFeatures.initEventSourcing(readModels, dbUrl);
      closeStore = close;
      const messageBus = controlledMessageBus(
        eventSourcingFeatures.initMessageBus(eventStore, [...commandHandlers]),
        new Set(commandHandlers.map(registration => registration.commandType)),
      );
      closeBus = () => messageBus.close();
      return { eventStore, messageBus };
    },
    start() {
      // Marks the plugin active so DOT will run `stop`, where the dispatcher
      // closes before dispose releases the store pool.
    },
    async stop() {
      await closeBus?.();
    },
    async dispose() {
      await closeBus?.();
      closeBus = undefined;
      if (closeStore !== undefined) {
        await closeStore();
        closeStore = undefined;
      }
    },
  });

  // Erasure seam: `needs` is assembled from runtime tokens, while the
  // return type re-attaches the token-derived wire shape for the app
  // builder guard. Same pattern as @arki/http's bundle collector.
  return inner as unknown as Plugin<BundleNeeds<TBundles> & EsFeatureNeeds<TFeatures>, EventSourcingServices>;
}
