import { oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { expectTypeOf } from 'vitest';
import { z } from 'zod';

import { asTool } from './contract.js';

const procedure = oc
  .$meta<{ policy: { roles: readonly string[] } }>({ policy: { roles: ['admin'] } })
  .input(z.object({ id: z.string() }))
  .output(z.object({ removed: z.boolean() }))
  .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } });

const tool = asTool(procedure, {
  description: 'Remove an account permanently.',
  access: { roles: ['admin'] },
  name: 'accounts_remove',
  effect: 'destructive',
  confirm: 'elicit',
  hidden: true,
  remediation: { NOT_FOUND: 'List accounts to choose an existing ID.' },
});

// Middleware must not erase the annotation that controls exposure and confirmation.
const implemented = implement(tool)
  .use(({ next }) => next())
  .handler(() => ({ removed: true }));

expectTypeOf(implemented['~orpc'].meta.mcp).toEqualTypeOf(tool['~orpc'].meta.mcp);
expectTypeOf(implemented['~orpc'].meta.mcp.name).toEqualTypeOf<'accounts_remove'>();
expectTypeOf(implemented['~orpc'].meta.mcp.confirm).toEqualTypeOf<'elicit'>();
expectTypeOf(implemented['~orpc'].meta.mcp.hidden).toEqualTypeOf<true>();
expectTypeOf(tool['~orpc'].inputSchema).toEqualTypeOf(procedure['~orpc'].inputSchema);
expectTypeOf(tool['~orpc'].outputSchema).toEqualTypeOf(procedure['~orpc'].outputSchema);
expectTypeOf(tool['~orpc'].errorMap).toEqualTypeOf(procedure['~orpc'].errorMap);
expectTypeOf(tool['~orpc'].meta.policy).toEqualTypeOf(procedure['~orpc'].meta.policy);

// @ts-expect-error irreversible actions require an explicit confirmation policy
asTool(procedure, { description: 'Remove an account.', access: 'user', effect: 'destructive' });
// @ts-expect-error descriptions are required even when the RPC route has one
asTool(procedure, { access: 'user', effect: 'read' });
// @ts-expect-error access must be explicitly declared
asTool(procedure, { description: 'Find an account.', effect: 'read' });
// @ts-expect-error effect must be explicitly declared
asTool(procedure, { description: 'Find an account.', access: 'user' });
// @ts-expect-error a router is not a procedure
asTool({ remove: procedure }, { description: 'Remove an account.', access: 'user', effect: 'read' });
asTool(procedure, {
  description: 'Find an account.',
  access: 'user',
  effect: 'read',
  // @ts-expect-error remediation may only name errors declared by this procedure
  remediation: { FORBIDDEN: 'Sign in.' },
});

const misspelled = { NOT_FOUND: 'List accounts.', NOT_FOND: 'List accounts.' };
// @ts-expect-error variables containing extra remediation keys must also be rejected
asTool(procedure, { description: 'Find an account.', access: 'user', effect: 'read', remediation: misspelled });
asTool(oc.input(z.string()), {
  description: 'Read a name.',
  access: 'public',
  effect: 'read',
  // @ts-expect-error a procedure without errors cannot declare remediation
  remediation: { NOT_FOUND: 'Try another name.' },
});

asTool(procedure, {
  description: 'Remove an account.',
  access: 'user',
  effect: 'destructive',
  confirm: { none: 'The caller has already confirmed account closure.' },
});
