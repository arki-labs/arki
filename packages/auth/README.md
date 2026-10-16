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

## Ownership checks: `@arki/auth/orpc`

Three assertion functions for oRPC handlers. Each one replaces the
"load, check for null, check the owner" dance with one call, and narrows the
row to non-null afterwards. Whether a stranger sees NOT_FOUND or FORBIDDEN
stays a choice the procedure makes by name — there is no policy engine to
configure (and so none to misconfigure).

```ts
import { assertFound, assertOwnedOrForbidden, assertOwnedOrNotFound } from '@arki/auth/orpc';

// Reads: someone else's story looks exactly like a missing one (no existence leak).
const story = await context.repos.stories.get(input.id);
assertOwnedOrNotFound(story, context.session.user.id, 'Story');
return story; // narrowed: no `!`

// Mutations where the caller already holds the id: "not yours" is a useful hint.
assertOwnedOrForbidden(story, context.session.user.id, 'Story');
```

**The `getOwned` convention.** When a repository can filter by owner in the
query, prefer that — the check then cannot be forgotten:

```ts
// infra/story-repository.ts
getOwned = async (id: StoryId, userId: UserId) =>
  (await this.db.select().from(stories).where(and(eq(stories.id, id), eq(stories.userId, userId))))[0] ?? null;

// procedure
const story = await context.repos.stories.getOwned(input.id, context.session.user.id);
assertFound(story, 'Story'); // NOT_FOUND: missing and not-yours are the same row-less result
```

Rows are matched on `userId`, compared as strings, so branded ids and session
ids fit without casts. `@orpc/server` is an optional peer; import this entry
only in an app that serves oRPC.

## Recipe 3: Magic-link sign-in

Server: pass a `send` function. The token is stored hashed.

```ts
import { defineAuthBackend } from '@arki/auth';
import { mailer } from '@arki/mail';
import { resend } from '@arki/mail/http/resend';
import { magicLink } from '@arki/mail/templates/auth';

const mail = mailer({ transport: resend({ apiKey: env.RESEND_API_KEY }), from: 'My App <no-reply@myapp.com>' });

export const auth = defineAuthBackend({
  // ...the options from Recipe 1
  magicLink: {
    disableSignUp: false, // true = only existing users may sign in this way
    send: async ({ email: to, url }) => {
      const { error } = await mail.send(magicLink, { appName: 'My App', url }, { to });
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

## Drizzle tables: `@arki/auth/schema`

The lib owns the shape of the four Better Auth tables. An app calls `createAuthTables` once with its pgSchema, its id columns and its own columns, and gets `{ User, Session, Account, Verification, userForeignKeys }` back. `userForeignKeys` is the factory other features use to point at the user table.

```ts
import { createAuthTables } from '@arki/auth/schema';
import { EMPTY_TWEAKS, tweaksColumn } from '@arki/auth/tweaks-column';

export const { User, Session, Account, Verification, userForeignKeys } = createAuthTables(schema, {
  naming: 'camel',
  fill: 'database',
  ids: {
    user: userIdFactory, // has primaryColumn() and createForeignKeyFactory()
    session: {
      primaryColumn: () =>
        text('id')
          .primaryKey()
          .$defaultFn(() => createPrefixedId('sess')),
    },
    account: accountIdFactory,
    verification: verificationIdFactory,
  },
  columns: {
    user: { tweaks: tweaksColumn().notNull().default(EMPTY_TWEAKS), accessGrantedAt: timestamp('accessGrantedAt') },
    session: { activeOrganizationId: text('activeOrganizationId') },
    // a standard key replaces that column: Better Auth's field name, your column name
    account: { accessTokenExpiresAt: timestamp('expiresAt') },
  },
});
```

- `naming` is `'snake'` (default, `email_verified`) or `'camel'` (`emailVerified`).
- `fill` (required) says who fills `createdAt`, `updatedAt` and `emailVerified` when a row is inserted without them. `'app'`: the app, through Drizzle's `$defaultFn`; the database sees no default, and `sessions` / `accounts` timestamps have none at all because Better Auth writes them. `'database'`: the database, through `DEFAULT now()` / `DEFAULT false`; every such column is `NOT NULL`. The row types follow: a column with a default is optional on insert.
- `ids` holds your id sources, one per table: anything with `primaryColumn()`, such as a `createIdFactory` result or a plain object. `user` also needs `createForeignKeyFactory`. The lib never makes ids.
- `columns` holds your own columns per table, merged after the standard ones. A new key adds a column; a standard key replaces that column; `id` is not allowed here (it comes from `ids`). The inferred row types include them.
- The column sets `authUserColumns`, `authSessionColumns`, `authAccountColumns`, `authVerificationColumns` are for apps that must build a table themselves. They take the same `naming` and `fill`, return fresh builders on every call, and a key you write after the spread replaces that column.
- Workspace (organization) tables come from `createWorkspaceTables` in `@arki/auth/workspaces` (Recipe 4).

## Recipe 4: Workspaces and roles

Turn on organizations and teams. Build the five org tables with `createWorkspaceTables` and add them to `schema`.

```ts
import { createWorkspaceTables } from '@arki/auth/workspaces';

export const { Organization, Member, Invitation, Team, TeamMember, orgForeignKeys, teamForeignKeys } =
  createWorkspaceTables(schema, {
    naming: 'camel',
    fill: 'database',
    user: User,
    ids: {
      organization: organizationIdSource,
      member: memberIdSource,
      invitation: invitationIdSource,
      team: teamIdSource,
      teamMember: teamMemberIdSource,
    },
  });
```

- `naming` and `fill` work as in `createAuthTables`; `fill` also covers `invitations.status` (`'pending'`) and `teams.memberCount` (`0`).
- `user` is your `User` table; members, invitations and team members point at its `id` with `onDelete: 'cascade'`. `invitations.teamId` is a plain column, as in Better Auth.
- `ids` holds one id source per table (anything with `primaryColumn()`). The lib never makes ids. Better Auth generates `organization_…` and `team_…` ids itself; use the same prefixes for rows you insert through Drizzle, so `organizationIdSchema` accepts them.
- `orgForeignKeys` / `teamForeignKeys` are the scope factories from `createWorkspaceForeignKeys`, already bound to these tables.

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
