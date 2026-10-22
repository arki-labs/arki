import type { AnySchema, ErrorMap, Meta } from '@orpc/contract';
import { ContractProcedure } from '@orpc/contract';

import type { Access, Effect, ToolName } from './types.js';

/** Model-facing policy attached to an explicitly exposed contract procedure. */
export type McpMeta = {
  readonly description: string;
  /** Listing policy; the procedure's middleware still authorizes the call. */
  readonly access: Access;
  readonly name?: ToolName;
  readonly idempotent?: boolean;
  readonly openWorld?: boolean;
  readonly budget?: { readonly maxChars: number };
  /** What the model should do next for a declared contract error. */
  readonly remediation?: Readonly<Record<string, string>>;
  /** Declared for inspection, never served. */
  readonly hidden?: true;
} & (
  | { readonly effect: Exclude<Effect, 'destructive'> }
  | { readonly effect: 'destructive'; readonly confirm: 'elicit' | { readonly none: string } }
);

/** Copy the contract definition, retaining its schemas, errors and existing policy metadata. */
export function asTool<
  I extends AnySchema,
  O extends AnySchema,
  E extends ErrorMap,
  Mt extends Meta,
  const M extends McpMeta & { remediation?: { readonly [K in keyof E as K & string]?: string } },
>(
  procedure: ContractProcedure<I, O, E, Mt>,
  mcp: M & {
    remediation?: Record<Exclude<keyof NonNullable<M['remediation']>, keyof E>, never>;
  },
): ContractProcedure<I, O, E, Mt & { readonly mcp: M }> {
  const def = procedure['~orpc'];
  return new ContractProcedure({ ...def, meta: { ...def.meta, mcp } });
}
