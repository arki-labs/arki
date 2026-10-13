import type {
  Command,
  CommandHandlerResult,
  CommandHandlerRetryOptions,
  Decider,
  DefaultCommandMetadata,
  DefaultRecord,
  Event,
  EventStore,
  HandleOptions,
} from '@event-driven-io/emmett';
import { DeciderCommandHandler } from '@event-driven-io/emmett';

import type { z, ZodType, ZodTypeAny } from '@arki/contracts';

import { debugCommand } from './debug.js';

type BuildCommand<
  CommandType extends string,
  Data extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
> = Command<CommandType, Data, Metadata extends undefined ? undefined : Metadata>;

type HandlerMetadata<Metadata> = Metadata extends undefined ? undefined : Metadata;

type MetadataInput<Metadata> = Metadata extends undefined ? { metadata?: undefined } : { metadata: Metadata };

type StreamResolver<Context, CommandType> = (params: { command: CommandType; context: Context }) => string;

export type CommandFlowExecuteOptions<
  Context,
  Store extends EventStore,
  Input extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
> = {
  context: Context;
  eventStore: Store;
  input: Input;
  streamId?: string;
  handleOptions?: HandleOptions<Store>;
} & MetadataInput<Metadata>;

export type CommandFlowHandlerArgs<
  Context,
  Store extends EventStore,
  CommandType,
  Input extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
  State,
  StreamEvent extends Event,
> = {
  command: CommandType;
  context: Context;
  eventStore: Store;
  input: Input;
  metadata: HandlerMetadata<Metadata>;
  streamId?: string;
  handleOptions?: HandleOptions<Store>;
  run: (
    streamId: string,
    options?: {
      handleOptions?: HandleOptions<Store>;
    },
  ) => Promise<CommandHandlerResult<State, StreamEvent, Store>>;
};

export type CommandFlowHandler<
  Context,
  Store extends EventStore,
  CommandType,
  Input extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
  State,
  StreamEvent extends Event,
  ReturnType,
> = (
  args: CommandFlowHandlerArgs<Context, Store, CommandType, Input, Metadata, State, StreamEvent>,
) => Promise<ReturnType> | ReturnType;

type CommandFlowExecutor<
  Context,
  Store extends EventStore,
  Input extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
  ReturnType,
> = (options: CommandFlowExecuteOptions<Context, Store, Input, Metadata>) => Promise<ReturnType>;

export type CommandFlow<
  Context,
  Store extends EventStore,
  CommandType extends string,
  Input extends DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined,
  State,
  StreamEvent extends Event,
  ReturnType,
> = CommandFlowExecutor<Context, Store, Input, Metadata, ReturnType> & {
  readonly commandType: CommandType;
  readonly schemas: {
    input: ZodTypeAny;
    metadata?: ZodTypeAny;
    event: ZodTypeAny;
    state?: ZodTypeAny;
  };
  readonly decider: Decider<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent>;
  readonly createCommand: (
    input: Input,
    metadata?: HandlerMetadata<Metadata>,
  ) => BuildCommand<CommandType, Input, Metadata>;
  readonly runCommand: (options: {
    eventStore: Store;
    command: BuildCommand<CommandType, Input, Metadata>;
    streamId: string;
    handleOptions?: HandleOptions<Store>;
  }) => Promise<CommandHandlerResult<State, StreamEvent, Store>>;
  readonly resolveStreamId?: StreamResolver<Context, BuildCommand<CommandType, Input, Metadata>>;
};

export class CommandFlowBuilder<
  Context,
  Store extends EventStore,
  CommandType extends string,
  Input extends DefaultRecord = DefaultRecord,
  Metadata extends DefaultCommandMetadata | undefined = undefined,
  State = unknown,
  StreamEvent extends Event = Event,
> {
  private readonly commandType: CommandType;
  private inputSchema?: ZodTypeAny;
  private metadataSchema?: ZodTypeAny;
  private eventSchema?: ZodTypeAny;
  private stateSchema?: ZodTypeAny;
  private currentDecider?: Decider<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent>;
  private streamResolver?: StreamResolver<Context, BuildCommand<CommandType, Input, Metadata>>;
  private mapToStreamId?: (id: string) => string;
  private retryOptions?: CommandHandlerRetryOptions;

  constructor(commandType: CommandType) {
    this.commandType = commandType;
    debugCommand('Creating command flow builder for command: %s', commandType);
  }

  input<Schema extends ZodType<DefaultRecord>>(
    schema: Schema,
  ): CommandFlowBuilder<Context, Store, CommandType, z.infer<Schema>, Metadata, State, StreamEvent> {
    this.inputSchema = schema;
    debugCommand('[%s] Registered input schema', this.commandType);
    return this as unknown as CommandFlowBuilder<
      Context,
      Store,
      CommandType,
      z.infer<Schema>,
      Metadata,
      State,
      StreamEvent
    >;
  }

  metadata<Schema extends ZodType<DefaultCommandMetadata>>(
    schema: Schema,
  ): CommandFlowBuilder<Context, Store, CommandType, Input, z.infer<Schema>, State, StreamEvent> {
    this.metadataSchema = schema;
    debugCommand('[%s] Registered metadata schema', this.commandType);
    return this as unknown as CommandFlowBuilder<
      Context,
      Store,
      CommandType,
      Input,
      z.infer<Schema>,
      State,
      StreamEvent
    >;
  }

  events<Schema extends ZodType<Event>>(
    schema: Schema,
  ): CommandFlowBuilder<Context, Store, CommandType, Input, Metadata, State, z.infer<Schema>> {
    this.eventSchema = schema;
    debugCommand('[%s] Registered event schema', this.commandType);
    return this as unknown as CommandFlowBuilder<Context, Store, CommandType, Input, Metadata, State, z.infer<Schema>>;
  }

  state<Schema extends ZodType>(
    schema: Schema,
  ): CommandFlowBuilder<Context, Store, CommandType, Input, Metadata, z.infer<Schema>, StreamEvent> {
    this.stateSchema = schema;
    debugCommand('[%s] Registered state schema', this.commandType);
    return this as unknown as CommandFlowBuilder<
      Context,
      Store,
      CommandType,
      Input,
      Metadata,
      z.infer<Schema>,
      StreamEvent
    >;
  }

  decider<NextState>(
    decider: Decider<NextState, BuildCommand<CommandType, Input, Metadata>, StreamEvent>,
  ): CommandFlowBuilder<Context, Store, CommandType, Input, Metadata, NextState, StreamEvent> {
    this.currentDecider = decider as unknown as Decider<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent>;
    debugCommand('[%s] Registered decider', this.commandType);
    return this as unknown as CommandFlowBuilder<Context, Store, CommandType, Input, Metadata, NextState, StreamEvent>;
  }

  stream(resolver: StreamResolver<Context, BuildCommand<CommandType, Input, Metadata>>) {
    this.streamResolver = resolver;
    debugCommand('[%s] Registered stream resolver', this.commandType);
    return this;
  }

  mapStreamId(mapper: (id: string) => string) {
    this.mapToStreamId = mapper;
    debugCommand('[%s] Registered stream ID mapper', this.commandType);
    return this;
  }

  retry(options: CommandHandlerRetryOptions) {
    this.retryOptions = options;
    debugCommand('[%s] Configured retry options', this.commandType);
    return this;
  }

  handler<ReturnType = CommandHandlerResult<State, StreamEvent, Store>>(
    handler?: CommandFlowHandler<
      Context,
      Store,
      BuildCommand<CommandType, Input, Metadata>,
      Input,
      Metadata,
      State,
      StreamEvent,
      ReturnType
    >,
  ): CommandFlow<Context, Store, CommandType, Input, Metadata, State, StreamEvent, ReturnType> {
    const inputSchema = this.ensureInputSchema() as ZodType<Input>;
    const eventSchema = this.ensureEventSchema() as ZodType<StreamEvent>;
    const metadataSchema = this.metadataSchema as Metadata extends undefined ? undefined : ZodType<Metadata>;
    const stateSchema = this.stateSchema as ZodType<State> | undefined;
    const decider = this.ensureDecider();
    const streamResolver = this.streamResolver;
    const mapToStreamId = this.mapToStreamId;
    const retryOptions = this.retryOptions;

    const validatedDecider: Decider<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent> = {
      decide: (command, state) => {
        const safeState = stateSchema ? stateSchema.parse(state) : state;
        const result = decider.decide(command, safeState);

        const events = Array.isArray(result) ? result : [result];
        const parsed = events.map(evt => eventSchema.parse(evt));
        return Array.isArray(result) ? parsed : parsed[0]!;
      },
      evolve: (state, event) => {
        const parsedEvent = eventSchema.parse(event);
        const nextState = decider.evolve(state, parsedEvent);
        return stateSchema ? stateSchema.parse(nextState) : nextState;
      },
      initialState: () => {
        const initial = decider.initialState();
        return stateSchema ? stateSchema.parse(initial) : initial;
      },
    };

    const runner = DeciderCommandHandler<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent>({
      decide: validatedDecider.decide,
      evolve: validatedDecider.evolve,
      initialState: validatedDecider.initialState,
      mapToStreamId,
      retry: retryOptions,
    });

    const defaultHandler: CommandFlowHandler<
      Context,
      Store,
      BuildCommand<CommandType, Input, Metadata>,
      Input,
      Metadata,
      State,
      StreamEvent,
      CommandHandlerResult<State, StreamEvent, Store>
    > = async ({ command, context, run, streamId, handleOptions }) => {
      if (!streamResolver && !streamId) {
        debugCommand('[%s] ERROR: No stream resolver or streamId provided', this.commandType);
        throw new Error(
          `No stream resolver provided for command "${this.commandType}". Call .stream(...) or provide streamId.`,
        );
      }

      debugCommand('[%s] Resolving stream ID', this.commandType);
      const resolvedStream = streamId ?? streamResolver?.({ command, context });
      if (!resolvedStream) {
        debugCommand('[%s] ERROR: Failed to resolve stream ID', this.commandType);
        throw new Error(
          `Unable to resolve stream id for command "${this.commandType}". Provide a streamId when executing.`,
        );
      }

      debugCommand('[%s] Stream resolved to: %s', this.commandType, resolvedStream);
      return run(resolvedStream, { handleOptions });
    };

    const finalHandler = (handler ?? defaultHandler) as CommandFlowHandler<
      Context,
      Store,
      BuildCommand<CommandType, Input, Metadata>,
      Input,
      Metadata,
      State,
      StreamEvent,
      ReturnType
    >;

    const flowExecutor: CommandFlowExecutor<Context, Store, Input, Metadata, ReturnType> = async options => {
      const { context, eventStore, input, streamId, handleOptions } = options;
      const metadataOption = options as MetadataInput<Metadata>;

      debugCommand('[%s] Executing command flow with input: %O', this.commandType, input);

      const parsedInput = inputSchema.parse(input);
      debugCommand('[%s] Input validation passed', this.commandType);
      let parsedMetadata: HandlerMetadata<Metadata>;

      if (metadataSchema) {
        if (!('metadata' in metadataOption)) {
          debugCommand('[%s] ERROR: Metadata expected but not provided', this.commandType);
          throw new Error(`Metadata expected for command "${this.commandType}" but none was provided.`);
        }
        const metadataValue = (metadataOption as { metadata: Metadata }).metadata;
        parsedMetadata = metadataSchema.parse(metadataValue) as HandlerMetadata<Metadata>;
        debugCommand('[%s] Metadata validation passed', this.commandType);
      } else {
        parsedMetadata = undefined as HandlerMetadata<Metadata>;
      }

      const command = (metadataSchema
        ? {
            type: this.commandType,
            data: parsedInput,
            metadata: parsedMetadata,
            kind: 'Command' as const,
          }
        : {
            type: this.commandType,
            data: parsedInput,
            kind: 'Command' as const,
          }) as unknown as BuildCommand<CommandType, Input, Metadata>;

      debugCommand('[%s] Command created successfully', this.commandType);

      const run = (resolvedStreamId: string, runOptions?: { handleOptions?: HandleOptions<Store> }) => {
        debugCommand('[%s] Running command on stream: %s', this.commandType, resolvedStreamId);
        return runner(eventStore, resolvedStreamId, command, runOptions?.handleOptions ?? handleOptions);
      };

      const result = await finalHandler({
        command,
        context,
        eventStore,
        input: parsedInput,
        metadata: parsedMetadata,
        streamId,
        handleOptions,
        run,
      });

      debugCommand('[%s] Command execution completed successfully', this.commandType);
      return result;
    };

    const createCommand = (input: Input, metadataValue?: HandlerMetadata<Metadata>) => {
      const parsedInput = inputSchema.parse(input);

      if (metadataSchema) {
        if (metadataValue === undefined) {
          throw new Error(`Metadata expected for command "${this.commandType}" but none was provided.`);
        }

        const parsedMetadata = metadataSchema.parse(metadataValue) as HandlerMetadata<Metadata>;
        return {
          type: this.commandType,
          data: parsedInput,
          metadata: parsedMetadata,
          kind: 'Command' as const,
        } as unknown as BuildCommand<CommandType, Input, Metadata>;
      }

      if (metadataValue !== undefined) {
        throw new Error(
          `Metadata value provided for command "${this.commandType}" without metadata schema. Add .metadata(...) to the builder.`,
        );
      }

      return {
        type: this.commandType,
        data: parsedInput,
        kind: 'Command' as const,
      } as unknown as BuildCommand<CommandType, Input, Metadata>;
    };

    const schemas = {
      input: inputSchema,
      ...(metadataSchema ? { metadata: metadataSchema } : {}),
      event: eventSchema,
      ...(stateSchema ? { state: stateSchema } : {}),
    };

    const runCommand = ({
      eventStore,
      command,
      streamId,
      handleOptions,
    }: {
      eventStore: Store;
      command: BuildCommand<CommandType, Input, Metadata>;
      streamId: string;
      handleOptions?: HandleOptions<Store>;
    }) => {
      if (!streamId) {
        throw new Error(`Missing streamId when running command "${this.commandType}".`);
      }

      return runner(eventStore, streamId, command, handleOptions);
    };

    const flow = Object.assign(flowExecutor, {
      commandType: this.commandType,
      schemas,
      decider: validatedDecider,
      createCommand,
      runCommand,
    }) as CommandFlow<Context, Store, CommandType, Input, Metadata, State, StreamEvent, ReturnType>;

    if (streamResolver) {
      Object.assign(flow, {
        resolveStreamId: (resolverParams: { command: BuildCommand<CommandType, Input, Metadata>; context: Context }) =>
          streamResolver(resolverParams),
      });
    }

    debugCommand('[%s] Command flow built successfully', this.commandType);
    return flow;
  }

  private ensureInputSchema(): ZodTypeAny {
    if (!this.inputSchema) {
      throw new Error(
        `Command "${this.commandType}" is missing an input schema. Call .input(...) before defining the handler.`,
      );
    }
    return this.inputSchema;
  }

  private ensureEventSchema(): ZodTypeAny {
    if (!this.eventSchema) {
      throw new Error(
        `Command "${this.commandType}" is missing an event schema. Call .events(...) before defining the handler.`,
      );
    }
    return this.eventSchema;
  }

  private ensureDecider(): Decider<State, BuildCommand<CommandType, Input, Metadata>, StreamEvent> {
    if (!this.currentDecider) {
      throw new Error(
        `Command "${this.commandType}" is missing a decider definition. Call .decider(...) before defining the handler.`,
      );
    }

    return this.currentDecider;
  }
}

type Toolkit<Context, Store extends EventStore> = {
  command<CommandType extends string>(
    commandType: CommandType,
  ): CommandFlowBuilder<Context, Store, CommandType, DefaultRecord, undefined, unknown, Event>;
};

const createToolkit = <Context, Store extends EventStore>(): Toolkit<Context, Store> => ({
  command: commandType => new CommandFlowBuilder<Context, Store, typeof commandType>(commandType),
});

export const es = {
  $context<Context, Store extends EventStore = EventStore>() {
    return createToolkit<Context, Store>();
  },
};

export const eventSourcing = es;
