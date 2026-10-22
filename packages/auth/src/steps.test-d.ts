/**
 * The principal steps keep the app's own principal type for the handler (not `AnyPrincipal`), and a
 * route or procedure that does not declare the step's failures does not compile.
 */
import { os } from '@orpc/server';
import { describe, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { step as rpcStep } from '@arki/dot/orpc';
import { errorMap } from '@arki/failure/orpc';
import { step as httpStep, route, routes } from '@arki/http';

import type { authTables } from './__fixtures__/tables.js';
import type { PrincipalSource } from './http.js';
import type { UserId } from './ids.js';
import type { PrincipalFor } from './pg/types.js';
import { AccessDenied, AUTH_FAILURES, AuthenticationRequired } from './boundary-failures.js';
import { defineAuth } from './definition.js';
import { principalFromHeaders } from './http.js';
import { authed, role, verified } from './steps.js';

const definition = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  user: { fields: ['plan'] },
});
type NotesPrincipal = PrincipalFor<typeof definition, typeof authTables>;
declare const source: PrincipalSource<NotesPrincipal>;
type Context = { readonly principal: NotesPrincipal | null; readonly requestId: string };

describe('steps on oRPC', () => {
  it('the principal carries the fields the definition exposes', () => {
    expectTypeOf(definition.user?.fields).toEqualTypeOf<readonly ['plan'] | undefined>();
  });

  it('authed narrows principal to non-null, keeps its exact type and the other keys', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .use(rpcStep(authed))
      .handler(({ context }) => {
        expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal>();
        expectTypeOf(context.principal.user.id).toEqualTypeOf<UserId>();
        expectTypeOf(context.requestId).toEqualTypeOf<string>();
      });
  });

  it('verified and role() keep the principal type', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .use(rpcStep(verified))
      .use(rpcStep(role('admin')))
      .handler(({ context }) => {
        expectTypeOf(context.principal.user.plan).toEqualTypeOf<'free' | 'pro'>();
      });
  });

  it('without a step the principal may be null', () => {
    os.$context<Context>()
      .errors(errorMap(...AUTH_FAILURES))
      .handler(({ context }) => {
        expectTypeOf(context.principal).toEqualTypeOf<NotesPrincipal | null>();
      });
  });

  it('a step requires its exact declared refusals', () => {
    // @ts-expect-error auth.unauthenticated is absent from this procedure.
    os.$context<Context>().use(rpcStep(authed));
    os.$context<Context>().errors(errorMap(AuthenticationRequired)).use(rpcStep(authed));
    const onlyUnauthenticated = os.$context<Context>().errors(errorMap(AuthenticationRequired));
    // @ts-expect-error role also needs auth.forbidden, not only auth.unauthenticated.
    onlyUnauthenticated.use(rpcStep(role('admin')));
    os.$context<Context>()
      .errors(errorMap(AuthenticationRequired, AccessDenied))
      .use(rpcStep(role('admin')));
  });
});

describe('steps on @arki/http', () => {
  it('the handler sees the principal as non-null after authed', () => {
    const declared = route.get('/declared', { id: 'declared', failures: AUTH_FAILURES });
    routes()
      .use(httpStep(principalFromHeaders(source)))
      .use(httpStep(authed))
      .bind(declared, (_input, ctx) => {
        expectTypeOf(ctx.principal).toEqualTypeOf<NotesPrincipal>();
      });
  });

  it('a route that does not declare the failures does not compile', () => {
    const undeclared = route.get('/undeclared', { id: 'undeclared', output: z.string() });
    routes()
      .use(httpStep(principalFromHeaders(source)))
      .use(httpStep(authed))
      // @ts-expect-error the authed step can refuse with auth.unauthenticated, which this route does not declare.
      .bind(undeclared, () => 'unreachable');
  });
});
