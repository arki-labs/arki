/** Server binding and owned execution shared by reusable actions and independent adapter contracts. */
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { dynamicScope } from '@arki/async';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { parseAsync } from '@arki/failure/schema';

import type { ActionFailureDefinition, ActionOptions } from './action.js';
import { ACTION_FAILURES, ActionApprovalRequired, ActionNotExposed, ActionPrincipalRequired } from './action.js';
import { telemetryFor } from './telemetry.js';

type ExecutionDefinitions<Definitions extends readonly ActionFailureDefinition[]> = readonly [
  ...Definitions,
  ...typeof ACTION_FAILURES,
];

/** Inferred from the shared structured-concurrency owner, including typed acquisition and cleanup. */
export type ActionScope<Definitions extends readonly ActionFailureDefinition[]> = Parameters<
  Parameters<ReturnType<typeof dynamicScope<ExecutionDefinitions<Definitions>>>['run']>[0]
>[0];

/** Trusted adapter attestations, never fields accepted from an external request body. */
export type ActionInvocation = {
  readonly binding: string;
  /** The adapter authenticates credentials and checks expiry before asserting this. */
  readonly principal: 'anonymous' | 'authenticated';
  /** The adapter verifies approval bound to this caller, operation and input. */
  readonly approval: 'absent' | 'granted';
  readonly signal?: AbortSignal;
  readonly deadline?: AbortSignal;
};

function succeeded<Value>(value: Value): value is Exclude<Value, Failure> {
  return !isFailure<unknown>(value);
}

function failed<Value>(value: Value): value is Extract<Value, Failure> {
  return isFailure<unknown>(value);
}

/**
 * Bind services through a closure, after the browser-safe contract is declared.
 * Implementations can return only successful output input or listed canonical failures.
 * A request owns its resources and children until they settle, even on cancellation.
 *
 * @example
 * const lookup = bindAction(lookupAction, (input, scope) => catalog.find(input.id, scope.signal));
 * const result = await lookup.run(body, { binding: 'http', principal: 'anonymous', approval: 'absent' });
 */
export function bindAction<
  const Definition extends ActionOptions<StandardSchemaV1, StandardSchemaV1, readonly ActionFailureDefinition[]>,
  Result extends NoInfer<
    | StandardSchemaV1.InferInput<Definition['output']>
    | ReturnType<ExecutionDefinitions<Definition['failures']>[number]>
    | PromiseLike<
        | StandardSchemaV1.InferInput<Definition['output']>
        | ReturnType<ExecutionDefinitions<Definition['failures']>[number]>
      >
  >,
>(
  definition: Definition,
  implementation: (
    input: StandardSchemaV1.InferOutput<Definition['input']>,
    scope: ActionScope<Definition['failures']>,
  ) => Result,
) {
  const declared: Definition['failures'] = definition.failures;
  const definitions: ExecutionDefinitions<Definition['failures']> = [...declared, ...ACTION_FAILURES];
  const owner = dynamicScope(definitions);
  const telemetry = telemetryFor({ name: definition.id });
  type ParsedInput = StandardSchemaV1.InferOutput<Definition['input']>;
  function execute<Completed>(
    read: () => ReturnType<typeof parseAsync<ParsedInput>>,
    complete: (value: Exclude<Awaited<Result>, Failure>) => Completed,
    invocation: ActionInvocation,
  ) {
    return telemetry.span(
      'dot.action',
      () =>
        owner.run(async scope => {
          if (!definition.policy.exposure.includes(invocation.binding)) return ActionNotExposed();
          if (definition.policy.principal === 'required' && invocation.principal !== 'authenticated')
            return ActionPrincipalRequired();
          if (definition.policy.approval === 'required' && invocation.approval !== 'granted')
            return ActionApprovalRequired();
          const parsed = await read();
          if (failed(parsed)) return parsed;
          // The owner recognizes its own cancellation reason. Admission closes even
          // when an asynchronous validator ignored the signal while it was running.
          scope.signal.throwIfAborted();
          const outcome = await implementation(parsed, scope);
          if (failed(outcome)) {
            // Untyped JS callers still cannot leak an undeclared business failure.
            return definitions.some(failure => failure.is(outcome)) ? outcome : UnexpectedDefect({ cause: outcome });
          }
          if (succeeded(outcome)) return complete(outcome);
          throw new Error('Unreachable action outcome');
        }, invocation),
      { attributes: { 'dot.action.id': definition.id, 'dot.binding': invocation.binding } },
    );
  }
  return {
    definition,
    /** Validate an untyped invocation, including asynchronous input/output transformations. */
    run(input: unknown, invocation: ActionInvocation) {
      return execute(
        () => parseAsync<ParsedInput>(definition.input, input),
        async outcome => {
          const output = await parseAsync<StandardSchemaV1.InferOutput<Definition['output']>>(
            definition.output,
            outcome,
          );
          // Invalid server output is a defect, not a client input refusal.
          return failed(output) ? UnexpectedDefect({ cause: output }) : output;
        },
        invocation,
      );
    },
    /**
     * Bind to a transport that already parses input and validates output, such
     * as an oRPC handler. Successful output is still the output schema's INPUT;
     * the transport owns encoding/transformation. Never parse either schema twice.
     */
    handle(input: ParsedInput, invocation: ActionInvocation) {
      return execute(
        () => Promise.resolve(input),
        outcome => outcome,
        invocation,
      );
    },
  };
}
