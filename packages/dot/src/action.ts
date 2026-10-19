/** Browser-safe action contracts: schemas, canonical failures and explicit exposure policy. */
import type { Failure, FailureDefinition } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { ScopeFailed, SUPERVISOR_FAILURES } from '@arki/async';
import { defineFailure, FAILURE_ERROR_CODES, FailureError, InvalidInput, ValidatorDefect } from '@arki/failure';

import type { ActionDeclaration } from './plugin-contract.js';

/** An adapter may call only an explicitly exposed boundary.
 * @fix Use an adapter listed by the action contract.
 * @verify bun run test -- src/tests/action.test.ts
 */
export const ActionNotExposed = defineFailure('dot.action_not_exposed', {
  status: 404,
  message: 'This action is not exposed through this adapter.',
  remediation: 'Use an adapter listed by the action contract.',
});
/** The adapter must authenticate its caller before invoking this action.
 * @fix Authenticate the caller before invoking the action.
 * @verify bun run test -- src/tests/action.test.ts
 */
export const ActionPrincipalRequired = defineFailure('dot.action_principal_required', {
  status: 401,
  message: 'This action requires an authenticated principal.',
  remediation: 'Authenticate the caller at the adapter boundary.',
});
/** Approval must be verified for this invocation, not inferred from another exposure.
 * @fix Verify approval bound to the caller, action and input.
 * @verify bun run test -- src/tests/action.test.ts
 */
export const ActionApprovalRequired = defineFailure('dot.action_approval_required', {
  status: 403,
  message: 'This action requires approval.',
  remediation: 'Verify approval for this caller and operation before executing it.',
});

/** Failures owned by execution rather than the business implementation. */
export const ACTION_FAILURES = [
  InvalidInput,
  ValidatorDefect,
  ...SUPERVISOR_FAILURES,
  ScopeFailed,
  ActionNotExposed,
  ActionPrincipalRequired,
  ActionApprovalRequired,
] as const;

/** Canonical definitions are shared with errorMap(), HTTP routes and JSON revival. */
export type ActionFailureDefinition = Pick<FailureDefinition, 'code' | 'status' | 'is' | 'dataSchema'> &
  ((...args: never[]) => Failure);

/** Minimum authority is shared by every exposure, including internal jobs. */
export type ActionPolicy = {
  readonly exposure: readonly string[];
  readonly principal: 'optional' | 'required';
  readonly approval: 'none' | 'required';
  /** Metadata for an explicit retry owner; execution never retries implicitly. */
  readonly retry: 'never' | 'idempotent';
};

/** The action's only authoring source. Its implementation is bound separately on the server. */
export type ActionOptions<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
  Definitions extends readonly ActionFailureDefinition[],
> = {
  readonly id: string;
  readonly summary?: string;
  readonly input: Input;
  readonly output: Output;
  readonly failures: Definitions;
  readonly policy: ActionPolicy;
};

/**
 * Define a reusable action without importing server services or an implementation.
 * It implements Dot's existing ActionSource protocol; no second registry is needed.
 *
 * @example
 * const lookup = action({ id: 'catalog.lookup', input: LookupInput, output: Item,
 *   failures: [ItemMissing], policy: { exposure: ['rpc', 'http'], principal: 'optional', approval: 'none', retry: 'never' } });
 */
export function action<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
  const Definitions extends readonly ActionFailureDefinition[],
>(options: ActionOptions<Input, Output, Definitions>) {
  const failures = [...options.failures, ...ACTION_FAILURES] as const;
  const seen = new Set<string>();
  for (const definition of failures) {
    if (seen.has(definition.code))
      throw new FailureError(
        FAILURE_ERROR_CODES.duplicateCode,
        `Action ${options.id} repeats failure ${definition.code}.`,
        'List each business failure once; execution failures are supplied by Dot.',
      );
    seen.add(definition.code);
  }
  // Snapshot metadata so mutating an author's array cannot grant a new exposure.
  const policy = Object.freeze({ ...options.policy, exposure: Object.freeze([...options.policy.exposure]) });
  return Object.freeze({
    ...options,
    policy,
    failures: Object.freeze(failures),
    toDotAction(): ActionDeclaration {
      return {
        id: options.id,
        binding: 'action',
        direction: 'in',
        ...(options.summary === undefined ? {} : { summary: options.summary }),
        metaSchema: '@arki/dot/action@1',
        meta: {
          failures: failures.map(definition => definition.code),
          exposure: [...policy.exposure],
          principal: policy.principal,
          approval: policy.approval,
          retry: policy.retry,
        },
      };
    },
  });
}

/** The descriptor's members are inferred from action(), not restated. */
export type Action<
  Input extends StandardSchemaV1,
  Output extends StandardSchemaV1,
  Definitions extends readonly ActionFailureDefinition[],
> = ReturnType<typeof action<Input, Output, Definitions>>;
