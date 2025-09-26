# Dot Framework Enhancement Plan

## Vision

Transform Dot into a comprehensive, zero-boilerplate framework that abstracts authentication, database, schema, tRPC, and event sourcing setup while maintaining 100% TypeScript type safety and being highly developer and AI-friendly.

## Core Principles

- **Type Safety First**: No `any` types, end-to-end type inference
- **Zero Boilerplate**: Define once, use everywhere
- **AI-Friendly**: Predictable structure, self-documenting, natural language compatible
- **Developer Experience**: Hot reload, intelligent errors, auto-completion
- **Production Ready**: Built-in monitoring, security, performance optimization

## Phase 1: Core Abstractions

### 1. Enhanced Authentication Module (Better-Auth Wrapper)

- Wrap and extend better-auth functionality
- Pre-configured OAuth providers via better-auth plugins
- Session management leveraging better-auth's built-in system
- Extended RBAC/ABAC on top of better-auth
- MFA support through better-auth plugins
- Magic link and passwordless via better-auth
- Type-safe abstractions over better-auth API

### 2. Schema-First Development

- Unified schema definition language
- Auto-generation of:
  - Drizzle database schemas
  - Zod validation schemas
  - TypeScript types
  - OpenAPI specifications
  - GraphQL schemas (optional)
- Schema versioning and migration support
- Schema composition and inheritance

### 3. Repository Pattern Generator

- Auto-generate from schemas
- Standard CRUD operations
- Soft delete support
- Audit trail integration
- Built-in caching with TTL
- Pagination and cursor-based navigation
- Full-text search integration
- Relationship management

## Phase 2: Frontend Integration

### 4. React/Next.js Integration

- Auto-generated React hooks from tRPC routers
- Server component utilities
- Client component helpers
- Optimistic update patterns
- Real-time subscription support
- Automatic error boundaries
- Loading state management

### 5. Form Generation

- Generate forms from Zod schemas
- Complex field type support
- Multi-step forms
- File upload handling
- Dynamic form fields
- Validation and error display
- Accessibility compliance

## Phase 3: Developer Experience

### 6. CLI Tool

- `dot init` - Initialize new project with templates
- `dot generate` - Generate code from schemas
- `dot migrate` - Run database migrations
- `dot dev` - Start unified dev server
- `dot build` - Production build
- `dot deploy` - Deployment utilities
- `dot test` - Run tests with coverage

### 7. Development Server

- Unified dev server starting all services
- Hot reload support
- Automatic TypeScript compilation
- Database viewer/editor
- API playground
- Performance profiling
- Memory leak detection

### 8. Error Management

- Centralized error types
- Error serialization for client/server
- Automatic error tracking integration
- Error recovery strategies
- User-friendly error messages
- Debug mode with stack traces

## Phase 4: AI & Documentation

### 9. Documentation Generator

- Generate from code comments and schemas
- API documentation
- Component storybook
- Architecture diagrams
- Sequence diagrams
- Database ERD generation
- Deployment guides

### 10. AI Assistant Features

- Natural language to code generation
- Code explanation utilities
- Test case generation
- Performance optimization suggestions
- Security audit recommendations
- Code review assistance
- Migration path suggestions

## Implementation Priorities

### High Priority (Phase 1)

1. Enhanced Authentication Module
2. Schema-First Development
3. Repository Pattern Generator

### Medium Priority (Phase 2)

4. React/Next.js Integration
5. CLI Tool
6. Error Management

### Lower Priority (Phase 3)

7. Form Generation
8. Development Server
9. Documentation Generator
10. AI Assistant Features

## Success Metrics

- Reduction in boilerplate code by 80%
- Time to production reduced by 60%
- 100% type coverage
- Zero runtime type errors
- Developer satisfaction score > 9/10

## Next Steps

1. Design detailed architecture for Enhanced Authentication Module
2. Create proof of concept for schema-first approach
3. Build repository generator prototype
4. Gather feedback from development team
5. Iterate based on real-world usage

---

# Detailed Module Plans

## 1. Enhanced Authentication Module (Better-Auth Integration)

### Overview

A comprehensive authentication abstraction layer built on top of better-auth that provides zero-boilerplate configuration while leveraging better-auth's robust authentication features. This module wraps better-auth with type-safe abstractions and extends it with additional enterprise features.

### Architecture

#### Core Components

##### 1.1 Better-Auth Wrapper

The Dot auth module will wrap better-auth's core functionality and provide a simplified, type-safe API:

```typescript
// Dot wraps better-auth configuration
interface DotAuthConfig {
  providers?: AuthProviderConfig[];
  session?: SessionConfig;
  email?: EmailConfig;
  security?: SecurityConfig;
  rbac?: RBACConfig;
  mfa?: MFAConfig;
  hooks?: AuthHooks;
}

// Under the hood, transforms to better-auth config
function createBetterAuthConfig(dotConfig: DotAuthConfig): BetterAuthConfig {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'pg' }),
    plugins: [...transformProviders(dotConfig.providers)],
    // ... other better-auth config
  });
}
```

##### 1.2 Provider Abstraction

Simplify provider configuration while using better-auth's provider system:

```typescript
// Dot's simplified provider config
const providers = [
  googleProvider({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
  }),
  githubProvider({
    /* config */
  }),
  magicLinkProvider({
    /* config */
  }),
  credentialsProvider({
    passwordHasher: 'argon2',
    passwordPolicy: {
      /* rules */
    },
  }),
];

// Transforms to better-auth providers and plugins
```

**Supported via Better-Auth:**

- OAuth: Google, GitHub, Discord, Facebook, Apple, Twitter, etc.
- Magic Link (via better-auth plugin)
- Credentials (built-in to better-auth)
- oAuthProxy for development
- Expo support for mobile apps

##### 1.3 Session Management

Leverage better-auth's session management with additional utilities:

```typescript
// Dot extends better-auth sessions
interface DotSessionManager {
  // Wraps better-auth's session methods
  getSession(): Promise<Session | null>;
  createSession(userId: string): Promise<Session>;
  invalidateSession(sessionId: string): Promise<void>;

  // Additional utilities
  invalidateAllUserSessions(userId: string): Promise<void>;
  getActiveSessions(userId: string): Promise<Session[]>;
  validateToken(token: string): Promise<Session | null>;
}
```

**Leverages Better-Auth Features:**

- Built-in JWT/database sessions
- Automatic cookie handling
- CSRF protection
- Session expiry management
- Device tracking via better-auth

##### 1.4 Access Control (RBAC/ABAC Extension)

Extend better-auth with advanced access control:

```typescript
// Better-auth provides basic user model
// Dot adds RBAC/ABAC on top
interface DotAccessControl {
  // Role management
  assignRole(userId: string, role: string): Promise<void>;
  removeRole(userId: string, role: string): Promise<void>;
  getUserRoles(userId: string): Promise<Role[]>;

  // Permission checking
  hasPermission(userId: string, resource: string, action: string): Promise<boolean>;
  hasRole(userId: string, role: string): Promise<boolean>;

  // Policy evaluation (ABAC)
  evaluatePolicy(context: PolicyContext): Promise<boolean>;
}

// Integrate with better-auth's user model
interface ExtendedUser extends BetterAuthUser {
  roles?: Role[];
  permissions?: Permission[];
  attributes?: Record<string, any>;
}
```

**Implementation Strategy:**

- Store roles/permissions in separate tables
- Link to better-auth's user table via userId
- Use better-auth's database adapter for consistency
- Provide tRPC middleware for authorization

##### 1.5 Multi-Factor Authentication

Leverage better-auth plugins and extend with additional MFA options:

```typescript
// Dot MFA abstraction over better-auth plugins
interface DotMFAConfig {
  providers: ('totp' | 'sms' | 'email' | 'webauthn')[];
  required?: boolean | ((user: User) => boolean);
  gracePeriod?: number; // Days before MFA is enforced
}

// Uses better-auth plugins under the hood
function configureMFA(config: DotMFAConfig): BetterAuthPlugin[] {
  const plugins = [];

  if (config.providers.includes('totp')) {
    plugins.push(twoFactorPlugin()); // better-auth plugin
  }

  if (config.providers.includes('webauthn')) {
    plugins.push(passkeysPlugin()); // better-auth plugin
  }

  // Custom extensions for SMS, etc.
  return plugins;
}
```

**Better-Auth MFA Support:**

- TOTP via two-factor plugin
- WebAuthn via passkeys plugin
- Email OTP via custom implementation
- Backup codes management

### Usage Example

```typescript
// In your app initialization
const app = createDot('my-app')
  .withEnv(env)
  .withDb(schema, repositories)
  .withAuth({
    // Simplified configuration that transforms to better-auth
    providers: [
      'google', // Auto-configured if env vars present
      'github',
      'magicLink',
      'credentials',
    ],

    session: {
      strategy: 'database', // or 'jwt'
      expiresIn: '30d',
    },

    email: {
      from: 'noreply@example.com',
      provider: 'resend', // or 'sendgrid', 'ses', etc.
    },

    rbac: {
      roles: ['user', 'admin', 'moderator'],
      defaultRole: 'user',
    },

    mfa: {
      providers: ['totp', 'webauthn'],
      required: false,
    },

    hooks: {
      onSignIn: async ({ user, session }) => {
        // Custom logic
      },
    },
  })
  .bootstrap();

// Auto-generated auth utilities
const { auth, trpc } = app;

// Use in tRPC context - auth is already integrated
export const createTRPCContext = async opts => {
  const session = await auth.api.getSession(opts.headers);

  return {
    session,
    user: session?.user,
    // ... other context
  };
};

// Pre-configured tRPC procedures with auth
const protectedProcedure = trpc.protected; // Requires auth
const adminProcedure = trpc.admin; // Requires admin role
const withPermission = trpc.withPermission('resource', 'action');

// Better-auth API is still accessible
const betterAuthInstance = auth.instance; // Raw better-auth instance if needed
```

### Database Schema

```typescript
// Better-auth tables (auto-created by better-auth)
const betterAuthTables = {
  users: {
    id: string, // Dot configures prefix: 'usr_xxx'
    email: string,
    emailVerified: boolean,
    name: string,
    image: string,
    createdAt: Date,
    updatedAt: Date,
  },
  accounts: {
    id: string, // Prefix: 'acc_xxx'
    userId: string,
    provider: string,
    providerAccountId: string,
    // OAuth tokens
  },
  sessions: {
    id: string, // Prefix: 'sess_xxx'
    userId: string,
    token: string,
    expiresAt: Date,
    // Device info
  },
  verifications: {
    id: string, // Prefix: 'verif_xxx'
    identifier: string,
    value: string,
    expiresAt: Date,
  },
};

// Dot extends with RBAC tables
const dotAuthExtensions = {
  roles: {
    id: string, // Prefix: 'role_xxx'
    name: string,
    description: string,
    isSystem: boolean,
  },
  permissions: {
    id: string, // Prefix: 'perm_xxx'
    resource: string,
    action: string,
    description: string,
  },
  rolePermissions: {
    roleId: string,
    permissionId: string,
  },
  userRoles: {
    userId: string,
    roleId: string,
    assignedAt: Date,
  },
};
```

### Security Features

1. **Password Security:**
   - Configurable hashing algorithms (bcrypt, argon2, scrypt)
   - Password strength validation
   - Breach detection via HaveIBeenPwned
   - Password history
   - Account lockout after failed attempts

2. **Token Security:**
   - Secure random token generation
   - Token rotation
   - Refresh token rotation
   - CSRF protection
   - XSS prevention

3. **Session Security:**
   - Secure, httpOnly, sameSite cookies
   - Session fixation prevention
   - Concurrent session management
   - IP and user agent validation

4. **Audit Trail:**
   - Login attempts
   - Permission changes
   - Password changes
   - MFA events
   - Suspicious activity detection

### Configuration Options

```typescript
interface AuthConfig {
  // Provider configuration
  providers: AuthProvider[];

  // Session configuration
  session: {
    strategy: 'jwt' | 'database';
    storage?: 'cookie' | 'header' | 'localStorage';
    maxAge: number;
    updateAge: number;
    cookieOptions?: CookieOptions;
  };

  // Security configuration
  security: {
    passwordPolicy?: PasswordPolicy;
    accountLockout?: LockoutPolicy;
    trustedOrigins?: string[];
    rateLimit?: RateLimitConfig;
  };

  // MFA configuration
  mfa?: {
    required: boolean | ((user: User) => boolean);
    providers: MFAProvider[];
    gracePeriod?: number;
  };

  // Access control
  accessControl?: {
    defaultRole?: string;
    rbac?: RBACConfig;
    abac?: ABACConfig;
  };

  // Hooks for extensibility
  hooks?: {
    onSignIn?: (user: User, session: Session) => Promise<void>;
    onSignOut?: (session: Session) => Promise<void>;
    onSignUp?: (user: User) => Promise<void>;
    onPasswordReset?: (user: User) => Promise<void>;
    onMFAEnabled?: (user: User) => Promise<void>;
    onRoleChange?: (user: User, oldRole: Role, newRole: Role) => Promise<void>;
  };

  // Email templates
  emails?: {
    from: string;
    templates?: {
      verifyEmail?: EmailTemplate;
      resetPassword?: EmailTemplate;
      magicLink?: EmailTemplate;
      mfaCode?: EmailTemplate;
    };
  };
}
```

### Integration Points

1. **Frontend Components (React/Next.js):**

   ```tsx
   // Auto-generated components
   // Hooks
   import {
     SessionProvider,
     SignInForm,
     SignUpForm,
     usePermissions,
     UserProfile,
     useSession,
     useUser,
   } from '@dot/auth/react';
   ```

2. **Middleware:**

   ```typescript
   // Express middleware
   import { authMiddleware } from '@dot/auth/express';

   // Next.js middleware
   export { authMiddleware } from '@dot/auth/next';
   ```

3. **Testing Utilities:**

   ```typescript
   import { mockAuth, mockSession, mockUser } from '@dot/auth/testing';
   ```

### Benefits

1. **For Developers:**
   - No auth boilerplate to write
   - Type-safe throughout
   - Built-in security best practices
   - Easy to extend and customize

2. **For AI:**
   - Predictable structure
   - Well-documented interfaces
   - Clear separation of concerns
   - Standard patterns

3. **For Production:**
   - Battle-tested security
   - Performance optimized
   - Monitoring ready
   - Compliance support (GDPR, SOC2)

### Implementation Plan for Better-Auth Integration

#### Phase 1: Core Wrapper (Week 1)

1. **Better-Auth Configuration Abstraction**
   - Create `DotAuthConfig` interface
   - Transform function to convert Dot config to better-auth config
   - Provider factory functions for common providers
   - Environment variable auto-detection

2. **Session Management Wrapper**
   - Wrap better-auth session methods
   - Add utility methods for session management
   - Integrate with tRPC context creation

#### Phase 2: Provider Simplification (Week 2)

1. **OAuth Provider Presets**
   - Google, GitHub, Discord provider factories
   - Auto-configure from environment variables
   - Development proxy setup (oAuthProxy)

2. **Magic Link & Passwordless**
   - Wrap magic link plugin
   - Email template system
   - Rate limiting integration

#### Phase 3: RBAC Extension (Week 3)

1. **Role & Permission Tables**
   - Design schema for roles/permissions
   - Create Drizzle migrations
   - Repository pattern for RBAC

2. **Authorization Middleware**
   - tRPC procedure factories
   - Role-based procedures
   - Permission-based procedures
   - Resource ownership checks

#### Phase 4: Advanced Features (Week 4)

1. **MFA Integration**
   - TOTP plugin wrapper
   - WebAuthn/Passkeys wrapper
   - Backup codes management

2. **Audit & Security**
   - Login attempt tracking
   - Session activity logs
   - Suspicious activity detection

#### Phase 5: Developer Experience (Week 5)

1. **Type Generation**
   - Generate types from auth config
   - Session type exports
   - User type with roles/permissions

2. **Testing Utilities**
   - Mock auth provider
   - Test user factories
   - Session mocking

3. **Documentation & Examples**
   - API documentation
   - Migration guide from raw better-auth
   - Example applications
