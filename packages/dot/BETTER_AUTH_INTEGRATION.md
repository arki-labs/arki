# Better-Auth Integration Strategy for Dot Framework

## Overview

This document outlines how the Dot framework will wrap and extend better-auth to provide a zero-boilerplate authentication solution while maintaining the flexibility and robustness of better-auth.

## Core Philosophy

- **Wrap, Don't Replace**: Leverage better-auth's battle-tested features
- **Simplify Configuration**: Provide sensible defaults and auto-configuration
- **Extend Capabilities**: Add enterprise features like RBAC/ABAC
- **Maintain Access**: Always allow direct access to better-auth when needed

## Architecture

### 1. Configuration Layer

```typescript
// Dot's simplified auth config
interface DotAuthConfig {
  // Provider configuration
  providers?: Array<
    'google' | 'github' | 'discord' | 'facebook' | 'apple' | 'magicLink' | 'credentials' | CustomProvider
  >;

  // Session configuration
  session?: {
    strategy?: 'jwt' | 'database';
    expiresIn?: string; // '30d', '1h', etc.
    cookieOptions?: {
      secure?: boolean;
      sameSite?: 'lax' | 'strict' | 'none';
    };
  };

  // Email configuration
  email?: {
    from: string;
    provider: 'resend' | 'sendgrid' | 'ses' | 'smtp';
    templates?: EmailTemplates;
  };

  // RBAC configuration (Dot extension)
  rbac?: {
    enabled?: boolean;
    roles?: string[];
    defaultRole?: string;
    permissions?: PermissionSchema;
  };

  // MFA configuration
  mfa?: {
    providers?: ('totp' | 'sms' | 'email' | 'webauthn')[];
    required?: boolean | ((user: User) => boolean);
    gracePeriod?: number;
  };

  // Security configuration
  security?: {
    rateLimit?: RateLimitConfig;
    passwordPolicy?: PasswordPolicy;
    accountLockout?: LockoutConfig;
  };

  // Hooks for extensibility
  hooks?: {
    onSignIn?: (event: SignInEvent) => Promise<void>;
    onSignUp?: (event: SignUpEvent) => Promise<void>;
    onSignOut?: (event: SignOutEvent) => Promise<void>;
    // ... other hooks
  };
}
```

### 2. Transformation Layer

```typescript
// Transform Dot config to better-auth config
function toBetterAuthConfig(dotConfig: DotAuthConfig): BetterAuthConfig {
  const config: BetterAuthConfig = {
    database: drizzleAdapter(db, {
      provider: 'pg',
      usePlural: true,
    }),
    appName: dotConfig.appName,
    baseURL: getBaseUrl(),
    secret: getAuthSecret(),
    plugins: [],
    socialProviders: {},
  };

  // Transform providers
  if (dotConfig.providers) {
    const { socialProviders, plugins } = transformProviders(dotConfig.providers);
    config.socialProviders = socialProviders;
    config.plugins.push(...plugins);
  }

  // Configure session
  if (dotConfig.session) {
    config.session = transformSession(dotConfig.session);
  }

  // Add MFA plugins
  if (dotConfig.mfa) {
    config.plugins.push(...configureMFA(dotConfig.mfa));
  }

  return config;
}
```

### 3. Provider Factories

```typescript
// Provider factory functions
const providers = {
  google: () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.warn('Google provider configured but credentials not found in environment');
      return null;
    }

    return {
      clientId,
      clientSecret,
      scopes: ['email', 'profile'],
    };
  },

  github: () => {
    // Similar auto-configuration
  },

  magicLink: (config?: MagicLinkConfig) => {
    return magicLinkPlugin({
      sendMagicLink: config?.sendEmail || defaultEmailSender,
      expiresIn: config?.expiresIn || 60 * 15, // 15 minutes
    });
  },

  credentials: (config?: CredentialsConfig) => {
    return {
      enabled: true,
      passwordHasher: config?.passwordHasher || 'argon2',
      passwordPolicy: config?.passwordPolicy || defaultPasswordPolicy,
    };
  },
};
```

### 4. RBAC Extension

```typescript
// RBAC extension on top of better-auth
class DotRBACExtension {
  constructor(private betterAuth: BetterAuthInstance) {}

  async assignRole(userId: string, roleName: string) {
    // Check if role exists
    const role = await db.query.roles.findFirst({
      where: eq(roles.name, roleName),
    });

    if (!role) {
      throw new Error(`Role ${roleName} not found`);
    }

    // Assign role to user
    await db.insert(userRoles).values({
      userId,
      roleId: role.id,
      assignedAt: new Date(),
    });
  }

  async hasPermission(userId: string, resource: string, action: string): Promise<boolean> {
    // Get user roles
    const userRoles = await this.getUserRoles(userId);

    // Check permissions for each role
    for (const role of userRoles) {
      const hasPermission = await this.checkRolePermission(role.id, resource, action);
      if (hasPermission) return true;
    }

    return false;
  }

  // ... other RBAC methods
}
```

### 5. tRPC Integration

```typescript
// Auto-generate tRPC procedures with auth
export function createAuthProcedures(auth: DotAuth) {
  const t = initTRPC.context<Context>().create();

  return {
    // Public procedure
    public: t.procedure,

    // Protected procedure (requires authentication)
    protected: t.procedure.use(({ ctx, next }) => {
      if (!ctx.session?.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }
      return next({
        ctx: {
          session: ctx.session,
          user: ctx.session.user,
        },
      });
    }),

    // Admin procedure
    admin: t.procedure.use(async ({ ctx, next }) => {
      if (!ctx.session?.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
      }

      const hasAdminRole = await auth.rbac.hasRole(ctx.session.user.id, 'admin');

      if (!hasAdminRole) {
        throw new TRPCError({ code: 'FORBIDDEN' });
      }

      return next({ ctx });
    }),

    // Permission-based procedure
    withPermission: (resource: string, action: string) => {
      return t.procedure.use(async ({ ctx, next }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({ code: 'UNAUTHORIZED' });
        }

        const hasPermission = await auth.rbac.hasPermission(ctx.session.user.id, resource, action);

        if (!hasPermission) {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }

        return next({ ctx });
      });
    },

    // Role-based procedure
    withRole: (roles: string[]) => {
      return t.procedure.use(async ({ ctx, next }) => {
        if (!ctx.session?.user) {
          throw new TRPCError({ code: 'UNAUTHORIZED' });
        }

        const userRoles = await auth.rbac.getUserRoles(ctx.session.user.id);
        const hasRequiredRole = roles.some(role => userRoles.includes(role));

        if (!hasRequiredRole) {
          throw new TRPCError({ code: 'FORBIDDEN' });
        }

        return next({ ctx });
      });
    },
  };
}
```

## Migration Path

### From Raw better-auth to Dot

```typescript
// Before: Raw better-auth
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { magicLink, oAuthProxy } from 'better-auth/plugins';

// After: With Dot
import { createDot } from '@arki/dot';

const auth = betterAuth({
  database: drizzleAdapter(db, { provider: 'pg' }),
  appName: 'MyApp',
  baseURL: 'http://localhost:3000',
  secret: process.env.AUTH_SECRET,
  plugins: [magicLink(), oAuthProxy()],
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  // ... lots of configuration
});

const app = createDot('my-app')
  .withEnv(env)
  .withDb(schema)
  .withAuth({
    providers: ['google', 'magicLink'],
    // Automatic configuration from env vars
  })
  .bootstrap();

const { auth } = app; // Fully configured auth with RBAC, MFA, etc.
```

### Accessing Better-Auth Directly

```typescript
// Dot provides the wrapped auth
const { auth } = app;

// But you can always access the underlying better-auth instance
const betterAuthInstance = auth.instance;

// Use better-auth API directly when needed
const session = await betterAuthInstance.api.getSession({
  headers: request.headers,
});

// Or use Dot's extended API
const userRoles = await auth.rbac.getUserRoles(userId);
```

## Benefits

### For Developers

1. **Zero Boilerplate**: Authentication configured in minutes
2. **Type Safety**: Full TypeScript support with type inference
3. **Flexibility**: Use Dot's abstractions or access better-auth directly
4. **Enterprise Features**: RBAC/ABAC out of the box

### For AI

1. **Predictable Structure**: Consistent patterns across projects
2. **Self-Documenting**: Clear interfaces and types
3. **Standard Patterns**: Following industry best practices

### For Production

1. **Battle-Tested**: Built on better-auth's proven foundation
2. **Security**: Best practices enforced by default
3. **Scalable**: Designed for enterprise applications
4. **Monitoring Ready**: Built-in audit trails and logs

## Implementation Timeline

### Week 1: Core Wrapper

- [ ] Create DotAuthConfig interface
- [ ] Implement config transformation
- [ ] Basic provider factories
- [ ] Session management wrapper

### Week 2: Provider & Email

- [ ] OAuth provider presets
- [ ] Magic link integration
- [ ] Email template system
- [ ] Rate limiting

### Week 3: RBAC Extension

- [ ] Design RBAC schema
- [ ] Implement role management
- [ ] Permission checking
- [ ] tRPC middleware

### Week 4: Advanced Features

- [ ] MFA plugin integration
- [ ] Audit trail system
- [ ] Security features

### Week 5: Polish & Documentation

- [ ] Type generation
- [ ] Testing utilities
- [ ] Documentation
- [ ] Example apps

## Next Steps

1. Review and approve this integration strategy
2. Set up development environment
3. Create proof of concept for core wrapper
4. Implement provider factories
5. Build RBAC extension
6. Create example applications
7. Write comprehensive tests
8. Document migration path
