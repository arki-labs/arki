import type {
  AnyContractRouter,
  ContractProcedure,
  ContractRouterClient,
  ErrorMap,
  InferSchemaInput,
  InferSchemaOutput,
} from '@orpc/contract';
import { ORPCError } from '@orpc/client';
import { getEventIteratorSchemaDetails, isContractProcedure } from '@orpc/contract';

import type { Failure, RevivalFailure } from '@arki/failure';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { reviveRpcError, RPC_FAILURE_DEFINITION, rpcFailureDefinitions } from '@arki/failure/orpc';

import type { McpMeta } from './contract.js';
import type { McpTool, ToolCall } from './tool.js';
import { toolResult } from './result.js';

/** Access refused. @fix Supply the required principal, roles and scopes. @verify bun run test -- src/orpc.test.ts */
export const Forbidden = defineFailure('mcp.forbidden', {
  status: 403,
  message: 'This principal cannot call the tool.',
  remediation: 'Use a principal with the required access.',
});
/** Approval absent. @fix Verify approval through the host authority. @verify bun run test -- src/orpc.test.ts */
export const ApprovalRequired = defineFailure('mcp.approval_required', {
  status: 403,
  message: 'The tool requires approval.',
  remediation: 'Obtain approval through the host and retry.',
});
/** Native input validation refused the call. @fix Correct the tool arguments. @verify bun run test -- src/orpc.test.ts */
export const InvalidInput = defineFailure('mcp.invalid_input', {
  status: 400,
  message: 'The tool arguments are invalid.',
  remediation: 'Correct the arguments and retry.',
});
/** Invocation cancelled. @fix Start a new invocation when still needed. @verify bun run test -- src/orpc.test.ts */
export const Cancelled = defineFailure('mcp.cancelled', {
  status: 499,
  message: 'The tool call was cancelled.',
  remediation: 'Start a new call if the result is still needed.',
});
export const ADAPTER_FAILURES = [Forbidden, ApprovalRequired, InvalidInput, Cancelled, UnexpectedDefect] as const;
type AdapterFailure = ReturnType<(typeof ADAPTER_FAILURES)[number]> | RevivalFailure;

export type Snake<Name extends string> = Name extends `${infer First}${infer Rest}`
  ? `${First extends Lowercase<First> ? First : `_${Lowercase<First>}`}${Snake<Rest>}`
  : '';
type NormalizePrefix<Name extends string> = Name extends `${infer Before}.${infer After}`
  ? NormalizePrefix<`${Before}_${After}`>
  : Name extends `${infer Before}#${infer After}`
    ? NormalizePrefix<`${Before}_${After}`>
    : Lowercase<Name>;
type ToolKey<Prefix extends string, Key extends string, M extends McpMeta> = M extends {
  name: infer Name extends string;
}
  ? Name
  : `${NormalizePrefix<Prefix>}_${Snake<Key>}`;
type MapFailure<E extends ErrorMap> = E[keyof E] extends infer Entry
  ? Entry extends { readonly [RPC_FAILURE_DEFINITION]: infer Definition }
    ? Definition extends (...args: never[]) => infer F
      ? F extends Failure
        ? F
        : never
      : never
    : never
  : never;
type LeafTools<Prefix extends string, Key extends string, Value> =
  Value extends ContractProcedure<infer I, infer O, infer E, infer M>
    ? M extends { mcp: infer Policy extends McpMeta }
      ? Policy extends { hidden: true }
        ? Record<never, never>
        : Record<
            ToolKey<Prefix, Key, Policy>,
            McpTool<InferSchemaInput<I>, InferSchemaOutput<O>, MapFailure<E> | AdapterFailure>
          >
      : Record<never, never>
    : Value extends object
      ? RpcTools<Prefix, Value>
      : Record<never, never>;
type Intersect<Union> = (Union extends unknown ? (value: Union) => void : never) extends (value: infer Value) => void
  ? Value
  : never;
export type RpcTools<Prefix extends string, Contract extends object> = Intersect<
  {
    [Key in keyof Contract & string]: LeafTools<Prefix, Key, Contract[Key]>;
  }[keyof Contract & string]
>;

type NoncanonicalErrors<E extends ErrorMap> = {
  [Code in keyof E]: E[Code] extends { readonly [RPC_FAILURE_DEFINITION]: infer Definition }
    ? Definition extends ((...args: never[]) => Failure) & { readonly code: Code }
      ? never
      : Code
    : Code;
}[keyof E];
type NoncanonicalLeaves<C extends object> = {
  [Key in keyof C]: C[Key] extends ContractProcedure<infer _I, infer _O, infer E, infer M>
    ? M extends { mcp: infer Policy extends McpMeta }
      ? Policy extends { hidden: true }
        ? never
        : NoncanonicalErrors<E> extends never
          ? never
          : Key
      : never
    : C[Key] extends object
      ? NoncanonicalLeaves<C[Key]> extends never
        ? never
        : Key
      : never;
}[keyof C];
type CanonicalErrorsGuard<C extends object> =
  NoncanonicalLeaves<C> extends never
    ? unknown
    : {
        readonly 'MCP: executable errors require canonical failure definitions': NoncanonicalLeaves<C>;
      };

type Options<C extends AnyContractRouter> = {
  readonly prefix?: string;
  /** Invoke the gateway client, preserving root and procedure middleware. */
  readonly client: (call: ToolCall) => ContractRouterClient<C>;
  /** Child router mounts are owned by the child's adapter. */
  readonly mountedPaths?: readonly (readonly string[])[];
};

export function fromRpc<const Feature extends string, C extends AnyContractRouter>(
  entry: { readonly feature: Feature; readonly contract: C; readonly router: unknown } & CanonicalErrorsGuard<
    NoInfer<C>
  >,
  options: Options<NoInfer<C>> & { readonly prefix?: undefined },
): RpcTools<Feature, C>;
export function fromRpc<const Prefix extends string, C extends AnyContractRouter>(
  entry: { readonly feature: string; readonly contract: C; readonly router: unknown } & CanonicalErrorsGuard<
    NoInfer<C>
  >,
  options: Options<NoInfer<C>> & { readonly prefix: Prefix },
): RpcTools<Prefix, C>;
export function fromRpc(
  entry: { readonly feature: string; readonly contract: object; readonly router: unknown },
  options: {
    readonly prefix?: string;
    readonly client: (call: ToolCall) => object;
    readonly mountedPaths?: readonly (readonly string[])[];
  },
) {
  const tools: Record<string, McpTool<unknown, unknown, Failure>> = {};
  const prefix = (options.prefix ?? entry.feature).replaceAll('.', '_').replaceAll('#', '_').toLowerCase();
  const visit = (router: object, path: readonly string[]) => {
    for (const [key, value] of Object.entries(router)) {
      const here = [...path, key];
      if (options.mountedPaths?.some(mount => mount.every((part, index) => here[index] === part))) continue;
      if (!isContractProcedure(value)) {
        if (typeof value === 'object' && value !== null) visit(value, here);
        continue;
      }
      const def = value['~orpc'];
      const policy: unknown = def.meta.mcp;
      if (policy === undefined) continue;
      if (!isPolicy(policy)) throw new TypeError(`Invalid MCP policy at ${here.join('.')}`);
      if (policy.hidden) continue;
      for (const [code, source] of Object.entries(def.errorMap)) {
        const item: unknown = source;
        if (typeof item !== 'object' || item === null || !(RPC_FAILURE_DEFINITION in item)) {
          throw new TypeError(`MCP tool ${here.join('.')}: error ${code} requires a canonical failure definition.`);
        }
        const definition: unknown = item[RPC_FAILURE_DEFINITION];
        if (typeof definition !== 'function' || !('code' in definition) || definition.code !== code) {
          throw new TypeError(
            `MCP tool ${here.join('.')}: error ${code} has a mismatched canonical failure definition.`,
          );
        }
      }
      if (getEventIteratorSchemaDetails(def.outputSchema))
        throw new TypeError('Streaming MCP tools are not supported.');
      const name = policy.name ?? `${prefix}_${key.replaceAll(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
      if (Object.hasOwn(tools, name)) throw new TypeError(`Duplicate MCP tool: ${name}`);
      const run = async (input: unknown, call: ToolCall) => {
        try {
          if (!allowed(policy, call)) return Forbidden();
          if (cancelled(call)) return Cancelled();
          if (
            policy.effect === 'destructive' &&
            policy.confirm === 'elicit' &&
            (call.approve === undefined ||
              !(await call.approve({ name, input, principal: call.principal, signal: call.signal })))
          ) {
            return ApprovalRequired();
          }
          // The typed gateway client owns validation, transforms and authorization.
          if (cancelled(call)) return Cancelled();
          let client: unknown = options.client(call);
          let receiver: object | undefined;
          for (const part of here) {
            if ((typeof client !== 'object' && typeof client !== 'function') || client === null)
              return UnexpectedDefect();
            receiver = client;
            client = Reflect.get(client, part);
          }
          if (typeof client !== 'function') return UnexpectedDefect();
          const output: unknown = await Reflect.apply(client, receiver, [
            def.inputSchema === undefined ? undefined : input,
            { signal: call.signal },
          ]);
          return output;
        } catch (error) {
          if (cancelled(call)) return Cancelled();
          const definitions = rpcFailureDefinitions(def.errorMap);
          if (error instanceof ORPCError && definitions.some(definition => definition.code === error.code)) {
            const failure = reviveRpcError(error, definitions);
            if (failure !== undefined) return failure;
          }
          if (error instanceof ORPCError) {
            if (error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED') return Forbidden();
            if (error.code === 'BAD_REQUEST') return InvalidInput();
          }
          return UnexpectedDefect({ cause: error });
        }
      };
      Object.defineProperty(tools, name, {
        enumerable: true,
        value: {
          name,
          description: policy.description,
          meta: policy,
          input: def.inputSchema,
          output: def.outputSchema,
          errorMap: def.errorMap,
          annotations: {
            readOnlyHint: policy.effect === 'read',
            destructiveHint: policy.effect === 'destructive',
            idempotentHint: policy.idempotent ?? false,
            openWorldHint: policy.openWorld ?? false,
          },
          run,
          invoke: async (input: unknown, call: ToolCall) =>
            toolResult(
              await run(input, call),
              Math.min(policy.budget?.maxChars ?? call.budget.maxChars, call.budget.maxChars),
            ),
        },
      });
    }
  };
  visit(entry.contract, []);
  return tools;
}

function allowed(policy: McpMeta, call: ToolCall): boolean {
  if (policy.access === 'public') return true;
  if (call.principal === null) return false;
  if (policy.access === 'user') return true;
  return (
    (policy.access.roles?.every(role => call.principal?.roles.includes(role)) ?? true) &&
    (policy.access.scopes?.every(scope => call.scopes?.includes(scope)) ?? true)
  );
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}
function isPolicy(value: unknown): value is McpMeta {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('description' in value) ||
    typeof value.description !== 'string' ||
    !('access' in value) ||
    !('effect' in value)
  )
    return false;
  const access = value.access;
  if (
    access !== 'public' &&
    access !== 'user' &&
    (typeof access !== 'object' ||
      access === null ||
      ('roles' in access && !strings(access.roles)) ||
      ('scopes' in access && !strings(access.scopes)))
  )
    return false;
  if ('name' in value && (typeof value.name !== 'string' || !/^[\d_a-z][\da-z]*_\w+$/.test(value.name))) return false;
  if ('hidden' in value && value.hidden !== true) return false;
  if ('idempotent' in value && typeof value.idempotent !== 'boolean') return false;
  if ('openWorld' in value && typeof value.openWorld !== 'boolean') return false;
  if (
    'budget' in value &&
    (typeof value.budget !== 'object' ||
      value.budget === null ||
      !('maxChars' in value.budget) ||
      typeof value.budget.maxChars !== 'number' ||
      !Number.isSafeInteger(value.budget.maxChars) ||
      value.budget.maxChars <= 0)
  )
    return false;
  if (
    'remediation' in value &&
    (typeof value.remediation !== 'object' ||
      value.remediation === null ||
      !Object.values(value.remediation).every(text => typeof text === 'string'))
  )
    return false;
  if (value.effect === 'read' || value.effect === 'write') return true;
  return (
    value.effect === 'destructive' &&
    'confirm' in value &&
    (value.confirm === 'elicit' ||
      (typeof value.confirm === 'object' &&
        value.confirm !== null &&
        'none' in value.confirm &&
        typeof value.confirm.none === 'string'))
  );
}

function cancelled(call: ToolCall): boolean {
  return call.signal.aborted;
}

export { ResultTooLarge, InvalidResult } from './result.js';
