import type { z } from '@arki/contracts';

import type { Command, DefaultCommandMetadata } from '../command.js';
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
): (input: TInput, metadata?: TMetadata) => Command<TType, TInput, TMetadata> {
  const { type, inputSchema, metadataSchema } = config;

  return (input: TInput, metadata?: TMetadata) => {
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
}
