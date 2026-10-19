import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import type { AnySchema, ErrorMap } from '@orpc/contract';

import type { AnyPrincipal } from '@arki/auth';
import type { Failure } from '@arki/failure';

import type { McpMeta } from './contract.js';

/** Trusted request context. None of these fields comes from tool arguments. */
export type ToolCall = {
  readonly principal: AnyPrincipal | null;
  readonly signal: AbortSignal;
  readonly budget: { readonly maxChars: number };
  /** Granted delegated scopes, populated by the application's principal mapper. */
  readonly scopes?: readonly string[];
  /** Approval authority belongs to the host; absence or refusal fails closed. */
  readonly approve?: (request: {
    readonly name: string;
    readonly input: unknown;
    readonly principal: AnyPrincipal | null;
    readonly signal: AbortSignal;
  }) => boolean | Promise<boolean>;
};

/** Executable projection of one explicitly exposed procedure. */
export type McpTool<Input, Output, Failures extends Failure> = {
  readonly name: string;
  readonly description: string;
  readonly meta: McpMeta;
  readonly input: AnySchema | undefined;
  readonly output: AnySchema | undefined;
  readonly errorMap: ErrorMap;
  readonly annotations: ToolAnnotations;
  readonly run: (input: Input, call: ToolCall) => Promise<Output | Failures>;
  readonly invoke: (input: Input, call: ToolCall) => Promise<CallToolResult>;
};
