# Using Dot Framework with Better-Auth Integration

This guide shows how to use the new better-auth integration in the Dot framework.

## Basic Setup

```typescript
import { createDot } from '@arki/dot';

// Create your app with auth configuration
const app = await createDot('my-app')
  .withEnv(env)
  .withDb(schema, repositories)
  .withAuth({
    // Auth configuration (all optional - will auto-detect from env)
    providers: ['google', 'github', 'credentials'],
    session: {
      strategy: 'database',
      expiresIn: '30d',
    },
    rbac: {
      enabled: true,
      roles: ['admin', 'user'],
      defaultRole: 'user',
    },
  })
  .withTrpc(routers)
  .bootstrap();

// Access the auth instance
const { auth } = app;

// Use auth in your application
if (auth) {
  // Get session from headers
  const session = await auth.getSession(headers);

  // Check permissions
  const hasPermission = await auth.rbac.hasPermission(userId, 'posts', 'write');

  // Assign roles
  await auth.rbac.assignRole(userId, 'moderator');
}
```

## Using Auth Presets

```typescript
import { createDot, authPresets } from '@arki/dot';

// Use a preset configuration
const app = await createDot('my-app')
  .withEnv(env)
  .withDb(schema, repositories)
  .withAuth(authPresets.full())  // Full-featured auth with OAuth, MFA, and RBAC
  .withTrpc(routers)
  .bootstrap();
```

Available presets:
- `authPresets.basic()` - Email/password auth only
- `authPresets.socialOnly()` - OAuth providers only
- `authPresets.full()` - Everything enabled
- `authPresets.enterprise()` - Enterprise features with SSO and strict security

## Auto-Configuration from Environment

The auth module automatically detects configuration from environment variables:

```bash
# OAuth Providers (auto-detected when present)
GOOGLE_CLIENT_ID=xxx
GOOGLE_CLIENT_SECRET=xxx
GITHUB_CLIENT_ID=xxx
GITHUB_CLIENT_SECRET=xxx

# Auth Secret
AUTH_SECRET=xxx  # or BETTER_AUTH_SECRET

# URLs
BASE_URL=http://localhost:3000
PRODUCTION_URL=https://myapp.com

# Email (if using magic links or password reset)
EMAIL_FROM=noreply@myapp.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=xxx
SMTP_PASSWORD=xxx
```

```typescript
// No config needed - everything is auto-detected
const app = await createDot('my-app')
  .withEnv(env)
  .withDb(schema, repositories)
  .withAuth()  // Auto-configures from environment
  .withTrpc(routers)
  .bootstrap();
```

## Using in tRPC Procedures

The auth module integrates seamlessly with tRPC:

```typescript
// The auth context is automatically available in procedures
export const createPost = protectedProcedure
  .input(createPostSchema)
  .mutation(async ({ ctx, input }) => {
    const { user, rbac } = ctx;

    // Check permission using RBAC
    if (!await rbac.hasPermission(user.id, 'posts', 'create')) {
      throw new TRPCError({ code: 'FORBIDDEN' });
    }

    // Create post with user association
    return ctx.repo.posts.create({
      ...input,
      authorId: user.id,
    });
  });

// Use role-based procedures
export const adminRouter = createTRPCRouter({
  // This procedure requires admin role
  deleteUser: adminProcedure
    .input(z.object({ userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.repo.users.delete(input.userId);
    }),
});

// Create custom permission-based procedures
export const moderatorProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!await ctx.rbac.hasRole(ctx.user.id, 'moderator')) {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return next();
});
```

## Using Auth Middleware

The auth module provides pre-built middleware for common patterns:

```typescript
const { auth } = app;

// Create auth-aware procedures
const procedures = auth.createProcedures(t);

export const postRouter = createTRPCRouter({
  // Public - no auth required
  list: procedures.public
    .query(async ({ ctx }) => {
      return ctx.repo.posts.findMany();
    }),

  // Protected - requires authentication
  create: procedures.protected
    .input(createPostSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.repo.posts.create({
        ...input,
        authorId: ctx.user.id,
      });
    }),

  // Admin - requires admin role
  deleteAll: procedures.admin
    .mutation(async ({ ctx }) => {
      return ctx.repo.posts.deleteAll();
    }),

  // Custom permission
  moderate: procedures.withPermission('posts', 'moderate')
    .input(moderatePostSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.repo.posts.moderate(input);
    }),

  // Custom role
  review: procedures.withRole(['editor', 'reviewer'])
    .input(reviewPostSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.repo.posts.review(input);
    }),

  // Resource ownership
  update: procedures.withOwnership(
    async (input, ctx) => {
      const post = await ctx.repo.posts.findById(input.id);
      return post?.authorId;
    }
  )
    .input(updatePostSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.repo.posts.update(input);
    }),
});
```

## RBAC Examples

```typescript
const { rbac } = app.auth;

// Role Management
await rbac.createRole({
  name: 'editor',
  description: 'Can edit content',
  isSystem: false,
});

await rbac.assignRole(userId, 'editor');
await rbac.removeRole(userId, 'editor');

const userRoles = await rbac.getUserRoles(userId);
const hasRole = await rbac.hasRole(userId, 'editor');

// Permission Management
await rbac.createPermission({
  resource: 'posts',
  action: 'publish',
  description: 'Can publish posts',
});

await rbac.assignPermissionToRole('editor', permissionId);

const hasPermission = await rbac.hasPermission(userId, 'posts', 'publish');
const userPermissions = await rbac.getUserPermissions(userId);

// Policy Evaluation (for ABAC)
const canAccess = await rbac.evaluatePolicy({
  user,
  resource: 'posts',
  action: 'edit',
  attributes: { departmentId: 'marketing' },
  environment: { timeOfDay: 'business_hours' },
});
```

## Session Management

```typescript
const { session } = app.auth;

// Get session from headers
const currentSession = await session.getSession(headers);

// Create a new session
const newSession = await session.createSession(userId, {
  deviceInfo: 'Chrome on Windows',
  ipAddress: '192.168.1.1',
});

// Validate token
const validSession = await session.validateToken(token);

// Refresh session
const refreshedSession = await session.refreshSession(sessionId);

// Get all user sessions
const userSessions = await session.getActiveSessions(userId);

// Invalidate session
await session.invalidateSession(sessionId);

// Invalidate all user sessions (logout everywhere)
await session.invalidateAllUserSessions(userId);
```

## Migration from Raw Better-Auth

If you're currently using better-auth directly, migrating to Dot is straightforward:

### Before (Raw Better-Auth)
```typescript
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
});

// Manual session checking in procedures
const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const session = await auth.api.getSession({
    headers: ctx.headers,
  });

  if (!session) {
    throw new TRPCError({ code: 'UNAUTHORIZED' });
  }

  return next({ ctx: { ...ctx, session } });
});
```

### After (Dot Framework)
```typescript
import { createDot } from '@arki/dot';

const app = await createDot('my-app')
  .withEnv(env)
  .withDb(schema, repositories)
  .withAuth()  // Auto-configures everything
  .withTrpc(routers)
  .bootstrap();

// Auth is automatically integrated in procedures
// Just use protectedProcedure - session is already there!
```

## Direct Better-Auth Access

If you need direct access to the better-auth instance:

```typescript
const { auth } = app;

// Access the underlying better-auth instance
const betterAuthInstance = auth.instance;

// Use better-auth APIs directly
const session = await betterAuthInstance.api.getSession({
  headers: request.headers,
});

// All better-auth functionality is still available
const signInResult = await betterAuthInstance.api.signInEmail({
  body: {
    email: 'user@example.com',
    password: 'password123',
  },
});
```

## Conclusion

The Dot framework's better-auth integration provides:

- ✅ Zero-boilerplate configuration
- ✅ Auto-detection from environment variables
- ✅ Built-in RBAC and session management
- ✅ Seamless tRPC integration
- ✅ Type-safe throughout
- ✅ Access to underlying better-auth when needed
- ✅ Progressive enhancement (start simple, add features as needed)

You get all the power of better-auth with none of the setup complexity!