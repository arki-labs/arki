import type { z } from '@arki/contracts';

import type { Command, DefaultCommandMetadata } from '../command.js';
import type { EventSourcingActionDeclaration, JsonObject } from '../dot-action.js';
import { EVENT_SOURCING_ACTION_META_SCHEMA, schemaToJsonObject } from '../dot-action.js';
import type { DefaultRecord } from '../types.js';

/**
 * Configuration for defining a domain command factory.
 */
export type CommandConfig<
  TType extends string,
  TInput extends DefaultRecord,
  TMetadata extends DefaultCommandMetadata | undefined = undefined,
> = {
  /** The command type string (e.g., 'CreateUser') */
  type: TType;
  /** Zod schema for validating command input */
  inputSchema: z.ZodType<TInput>;
  /** Optional Zod schema for validating command metadata */
  metadataSchema?: z.ZodType<TMetadata>;
};

export type CommandFactory<
  TType extends string,
  TInput extends DefaultRecord,
  TMetadata extends DefaultCommandMetadata | undefined = undefined,
> = ((input: TInput, metadata?: TMetadata) => Command<TType, TInput, TMetadata>) &
  EventSourcingActionDeclaration & {
    readonly type: TType;
    readonly inputSchema: z.ZodType<TInput>;
    readonly metadataSchema?: z.ZodType<TMetadata>;
    toDotAction(): EventSourcingActionDeclaration;
  };

function commandAction<TType extends string>(
  type: TType,
  inputSchema: z.ZodType,
): EventSourcingActionDeclaration {
  return {
    id: type,
    binding: 'es',
    direction: 'in',
    address: type,
    metaSchema: EVENT_SOURCING_ACTION_META_SCHEMA,
    meta: {
      kind: 'command',
      input: schemaToJsonObject(inputSchema, `command "${type}" input`),
    },
  };
}

/**
 * Creates a strongly-typed command factory function.
 *
 * This factory validates input and metadata using Zod schemas before
 * creating commands that can be dispatched through a command flow or aggregate.
 *
 * @param config - Configuration object containing type, input schema, and optional metadata schema
 * @returns A factory function that validates and creates commands
 *
 * @example
 * ```ts
 * const createUserCommand = defineCommand({
 *   type: 'CreateUser',
 *   inputSchema: z.object({ name: z.string(), email: z.email() }),
 *   metadataSchema: z.object({ now: z.date(), issuedBy: z.string().uuid() }),
 * });
 *
 * const command = createUserCommand(
 *   { name: 'Ada', email: 'ada@example.org' },
 *   { now: new Date(), issuedBy: 'usr_123' },
 * );
 * ```
 */
export function defineCommand<
  TType extends string,
  TInput extends DefaultRecord,
  TMetadata extends DefaultCommandMetadata | undefined = undefined,
>(
  config: CommandConfig<TType, TInput, TMetadata>,
): CommandFactory<TType, TInput, TMetadata> {
  const { type, inputSchema, metadataSchema } = config;
  let cachedAction: EventSourcingActionDeclaration | undefined;

  const factory = (input: TInput, metadata?: TMetadata) => {
    const validatedInput = inputSchema.parse(input);
    const validatedMetadata = metadataSchema ? metadataSchema.parse(metadata) : metadata;

    // Conditionally construct the command object based on whether metadata is provided
    return (validatedMetadata === undefined
      ? {
          type,
          data: validatedInput,
          kind: 'Command' as const,
        }
      : {
          type,
          data: validatedInput,
          metadata: validatedMetadata,
          kind: 'Command' as const,
        }) as unknown as Command<TType, TInput, TMetadata>;
  };

  const getAction = (): EventSourcingActionDeclaration => {
    cachedAction ??= commandAction(type, inputSchema);
    return cachedAction;
  };

  Object.defineProperties(factory, {
    type: { value: type, enumerable: true },
    inputSchema: { value: inputSchema },
    ...(metadataSchema === undefined ? {} : { metadataSchema: { value: metadataSchema } }),
    id: { value: type, enumerable: true },
    binding: { value: 'es', enumerable: true },
    direction: { value: 'in', enumerable: true },
    address: { value: type, enumerable: true },
    metaSchema: { value: EVENT_SOURCING_ACTION_META_SCHEMA, enumerable: true },
    meta: {
      enumerable: true,
      get(): JsonObject {
        return getAction().meta;
      },
    },
    toDotAction: { value: getAction },
  });

  return factory as CommandFactory<TType, TInput, TMetadata>;
}
