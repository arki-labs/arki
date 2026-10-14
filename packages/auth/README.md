# @arki/auth

Authentication for Arki apps, built on [Better Auth](https://better-auth.com). It targets Bun, TanStack Start and oRPC.

It gives you:

- `defineAuthBackend`, one factory for a configured Better Auth instance (Drizzle, cookies, magic link, OAuth, Expo, workspaces).
- TanStack Start helpers: a route guard and a test-only session endpoint.
- Workspaces: organizations, teams and roles, with a scoping kernel for your own tables.
- Playwright helpers that sign a test user in once and reuse the session.
- Pure-JS scrypt password hashing that matches Better Auth's format.

## Install

```bash
bun add @arki/auth better-auth drizzle-orm
# For the TanStack Start helpers and React UI:
bun add @tanstack/react-start @tanstack/react-router react react-dom
# For the Playwright helpers (dev only):
bun add -d @playwright/test
```

Set a secret of at least 32 characters. In production a missing or shorter secret throws at startup.

```bash
AUTH_SECRET=$(openssl rand -base64 32)
```

The secret goes into each instance through its config. The package never writes it to `process.env`, so two auth instances in one process keep separate secrets and never accept each other's sessions.

## Recipe 1: Bun + TanStack Start server setup

Build the instance once, on the server.

```ts
// src/features/auth/auth.server.ts
import { createPrefixedIdHook, defineAuthBackend } from '@arki/auth';

import { db } from '~/db';
import { Account, Session, User, Verification } from '~/db/schema';
import { env } from '~/env';

export const auth = defineAuthBackend({
  db,
  schema: { user: User, account: Account, session: Session, verification: Verification },
  appName: 'My App',
  appKey: 'myapp', // cookie prefix: auth-myapp
  baseUrl: env.VITE_URL,
  productionUrl: env.PRODUCTION_URL,
  secret: env.AUTH_SECRET,
  generateId: createPrefixedIdHook(), // u_xxx, sess_xxx, acc_xxx, verif_xxx
  emailAndPassword: { enabled: true, requireEmailVerification: true },
});
```

Mount Better Auth's handler on a catch-all route.

```ts
// src/routes/api/auth/$.ts
import { createFileRoute } from '@tanstack/react-router';

import { auth } from '~/features/auth/auth.server';

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => auth.handler(request),
      POST: ({ request }) => auth.handler(request),
    },
  },
});
```

Guard pages with `createRequireAuth`. It reads the session through a server function, so it works on the first SSR load.

```ts
// src/features/auth/require-auth.ts
import { createServerFn } from '@tanstack/react-start';
import { getRequestHeaders } from '@tanstack/react-start/server';

import { createRequireAuth } from '@arki/auth/tanstack-start';

import { auth } from './auth.server';

const getSession = createServerFn({ method: 'GET' }).handler(async () =>
  auth.api.getSession({ headers: getRequestHeaders() }),
);

export const requireAuth = createRequireAuth(getSession);
// In a route: beforeLoad: requireAuth
```

## Recipe 2: oRPC protected procedure

Resolve the session once per request, then refuse calls without one.

```ts
// src/orpc.ts
import { ORPCError, os } from '@orpc/server';

import { auth } from '~/features/auth/auth.server';

type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

const o = os.$context<{ headers: Headers; session: Session | null }>();

export const publicProcedure = o;

export const protectedProcedure = o.use(async ({ context, next }) => {
  if (!context.session) {
    throw new ORPCError('UNAUTHORIZED', { message: 'You must be signed in.' });
  }
  return next({ context: { session: context.session, user: context.session.user } });
});

// In the oRPC route handler, build the context from the request:
// const headers = request.headers;
// const session = await auth.api.getSession({ headers });
// await handler.handle(request, { prefix: '/api/orpc', context: { headers, session } });

export const me = protectedProcedure.handler(({ context }) => ({ id: context.user.id, email: context.user.email }));
```

## Recipe 3: Magic-link sign-in

Server: pass a `send` function. The token is stored hashed.

```ts
import { defineAuthBackend } from '@arki/auth';
import { createEmailClient } from '@arki/emails';

const email = createEmailClient({ isDev: env.NODE_ENV === 'development', resend: { apiKey: env.RESEND_API_KEY } });

export const auth = defineAuthBackend({
  // ...the options from Recipe 1
  magicLink: {
    disableSignUp: false, // true = only existing users may sign in this way
    send: async ({ email: to, url }) => {
      const { error } = await email.send({
        to,
        from: 'My App <no-reply@myapp.com>',
        subject: 'Your sign-in link',
        text: `Sign in: ${url}`,
      });
      if (error) throw new Error('Could not send the sign-in email.');
    },
  },
});
```

Client: ask for a link, then the user clicks it.

```ts
import { magicLinkClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({ plugins: [magicLinkClient()] });

await authClient.signIn.magicLink({ email: 'ada@example.com', callbackURL: '/dashboard' });
```

## Recipe 4: Workspaces and roles

Turn on organizations and teams. Add the org tables (`organization`, `member`, `invitation`, `team`, `teamMember`) to `schema`.

```ts
export const auth = defineAuthBackend({
  // ...the options from Recipe 1
  schema: {
    user: User,
    account: Account,
    session: Session,
    verification: Verification,
    organization: Organization,
    member: Member,
    invitation: Invitation,
    team: Team,
    teamMember: TeamMember,
  },
  organization: { enabled: true, teams: true, membershipLimit: 25 },
});
```

Register each table that holds scoped rows. A row is personal, org-wide or team-scoped.

```ts
import { and, eq } from 'drizzle-orm';

import type { WorkspaceContext } from '@arki/auth/workspaces';
import {
  getWorkspaceResource,
  reassignScope,
  registerWorkspaceResource,
  resolveWriteScope,
  roleAtLeast,
  workspaceReadFilter,
} from '@arki/auth/workspaces';

registerWorkspaceResource({
  table: Note,
  idColumn: Note.id,
  userColumn: Note.userId,
  orgColumn: Note.organizationId,
  teamColumn: Note.teamId,
  shareRole: 'admin', // org-wide rows need admin or owner
});

// Build ctx per request from the session and fresh membership rows:
// { userId, activeOrganizationId, activeTeamId, memberTeamIds, role }
declare const ctx: WorkspaceContext;
const notes = getWorkspaceResource(Note);

// Read: only rows this user may see.
const rows = await db.select().from(Note).where(workspaceReadFilter(notes, ctx));

// Write: throws WorkspaceScopeError when the user lacks rights at the target.
const scope = resolveWriteScope(notes, { organizationId: ctx.activeOrganizationId, teamId: null }, ctx);
await db.insert(Note).values({ userId: ctx.userId, ...scope, body: 'Hello' });

// Move: pass the row's scope as stored now. The kernel refuses a row the user cannot see.
const [row] = await db.select().from(Note).where(eq(Note.id, noteId));
await reassignScope({
  config: notes,
  rowId: noteId,
  target: { organizationId: null, teamId: null },
  ctx,
  current: { userId: row.userId, organizationId: row.organizationId, teamId: row.teamId },
  applyUpdate: async next => {
    await db.update(Note).set(next).where(eq(Note.id, noteId));
  },
});

// Role check for admin-only actions.
if (!roleAtLeast(ctx.role, 'admin')) throw new Error('Admins only.');
```

Re-check membership when you build `ctx`. A member removed by an admin can still have the org set as active on an open session.

## Recipe 5: End-to-end test helpers

Add a test-only route that signs a user in. It returns 404 when `NODE_ENV=production`, and it only accepts reserved `.test` addresses unless you pass `allowEmail`.

```ts
// src/routes/api/e2e/create-session.ts
import { createFileRoute } from '@tanstack/react-router';

import { createE2EHandler } from '@arki/auth/tanstack-start';

import { auth } from '~/features/auth/auth.server';

export const Route = createFileRoute('/api/e2e/create-session')({
  server: {
    handlers: {
      POST: createE2EHandler({ auth, defaultEmail: 'e2e@myapp.test' }),
    },
  },
});
```

Sign in once in Playwright's global setup, then reuse the saved session.

```ts
// e2e/global-setup.ts
import { createAuthGlobalSetup, resolveAuthStatePath } from '@arki/auth/testing/playwright';

export default createAuthGlobalSetup({
  baseUrl: 'http://localhost:5180',
  authStatePath: resolveAuthStatePath(import.meta.url),
  email: 'e2e@myapp.test',
});
```

```ts
// e2e/dashboard.spec.ts
import { createAuthenticatedTest, resolveAuthStatePath } from '@arki/auth/testing/playwright';

const { test, expect } = createAuthenticatedTest({ authStatePath: resolveAuthStatePath(import.meta.url) });

test('dashboard loads for a signed-in user', async ({ authenticatedPage }) => {
  await authenticatedPage.goto('/dashboard');
  await expect(authenticatedPage.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
```

For two users (for example, to prove one cannot see the other's data), use `createTwoAccountGlobalSetup` and `createTwoAccountTest`.

To prove email/password stays on in production, use `assertEmailPasswordEnabled` from `@arki/auth/testing/production-boot` in a Vitest test. That entry needs `vitest`, an optional peer dependency.

## Password hashing

`@arki/auth/password` hashes with scrypt in pure JavaScript. The output format matches Better Auth, so hashes work in both directions.

```ts
import { hashPassword, verifyPassword } from '@arki/auth/password';

const hash = await hashPassword('correct horse battery staple');
await verifyPassword({ hash, password: 'correct horse battery staple' }); // true

// Or hand both to Better Auth:
// emailAndPassword: { enabled: true, password: { hash: hashPassword, verify: verifyPassword } }
```

## User vs Account

- **User** is a person in your app (one per person).
- **Account** is a way to sign in (many per user: password, Google, and so on).

Reference `userId` in your features, never `accountId`. Keep profile data on `User`. See [User vs Account](./docs/USER_VS_ACCOUNT.md).

## Guarding `@arki/http` routes

In a DOT app that serves HTTP through `@arki/http`, a guard is a typed context deriver. It reads the session from the request cookies and throws a coded 401 when there is none.

```ts
import { derive, HTTP_ERROR_CODES, HttpError, routes } from '@arki/http';

const withSession = derive('session', async req => {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) {
    throw new HttpError(401, HTTP_ERROR_CODES.unauthorized, 'sign-in required');
  }
  return session;
});

const bundle = routes()
  .derive(withSession)
  .derive('userId', (_req, ctx) => ctx.session.user.id)
  .bind(getProfile, async (_input, ctx) => profileRepo.findByUserId(ctx.userId));
```

Derivers do not run for `mount()`ed handlers. oRPC routers build their own per-request context (Recipe 2).

## Security notes

See [docs/security-review.md](./docs/security-review.md) for the full review.
