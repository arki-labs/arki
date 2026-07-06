# @arki/auth

Authentication utilities and configuration for Arki applications using better-auth.

## Overview

This package provides:

- better-auth configuration and setup
- User and session management
- OAuth provider integration
- Password utilities and security
- Email verification templates
- ID generation for auth entities

## Installation

```bash
pnpm add @arki/auth
```

## Usage

### Basic Setup

```typescript
import { auth } from '@arki/auth/dot.config';

// Use in your Next.js API routes
export const { GET, POST } = auth.handlers;
```

### Environment Variables

Required environment variables (see `src/env.ts`):

```env
# Application
AUTH_URL=http://localhost:3000
AUTH_SECRET=your-secret-key

# Database
DB_URL=postgresql://...

# OAuth Providers (optional)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# Email (optional, for email verification)
EMAIL_FROM=noreply@example.com
RESEND_API_KEY=
```

## Key Concepts

### User vs Account

**⚠️ Important**: Understanding the difference between "User" and "Account" is critical for building features correctly.

- **User** = A person in your application (one per person)
- **Account** = An authentication method (multiple per user)

**Read the full guide:** [User vs Account Documentation](./docs/USER_VS_ACCOUNT.md)

**Quick rules:**

- ✅ Always reference `userId` in your features
- ❌ Never reference `accountId` in application features
- ✅ Store profile data on `User` or related tables
- ❌ Never store profile data on `Account`

### ID Generation

```typescript
import { createAccountId, createSessionId, createUserId } from '@arki/auth/ids';

const userId = createUserId(); // "usr_..."
const accountId = createAccountId(); // "acc_..."
const sessionId = createSessionId(); // "ses_..."
```

### Password Utilities

```typescript
import { comparePasswords, hashPassword } from '@arki/auth/password';

// Hash a password
const hashedPassword = await hashPassword('user-password');

// Verify a password
const isValid = await comparePasswords('user-password', hashedPassword);
```

## Exports

### Main Exports (`@arki/auth`)

```typescript
import { auth } from '@arki/auth'; // better-auth instance
import { createUserId } from '@arki/auth/ids'; // ID generators
import { hashPassword } from '@arki/auth/password'; // Password utilities
```

### Security Utilities (`@arki/auth/security/*`)

```typescript
import { validateCsrf } from '@arki/auth/security/csrf';
import { rateLimit } from '@arki/auth/security/rate-limit';
```

### Email Schema (`@arki/auth/email/schema`)

```typescript
import { emailVerificationSchema } from '@arki/auth/email/schema';
```

## Documentation

- [**User vs Account**](./docs/USER_VS_ACCOUNT.md) - Essential reading for understanding authentication entities
- [Package Documentation](./docs/README.md) - Documentation index

## Common Use Cases

### Creating a User Reference in Your Feature

```typescript
// features/player-profile/tables.ts
import type { UserId } from '@arki/auth/ids';
import { users } from '@arki/db/schema';

export const playerProfiles = pgTable('player_profiles', {
  userId: varchar('user_id', { length: 256 })
    .$type<UserId>()
    .notNull()
    .references(() => users.id), // ✅ Reference User, not Account
  // ... other fields
});
```

### Accessing User in tRPC Procedures

```typescript
// features/player-profile/procedures/get-profile.ts
export const getProfile = protectedProcedure.query(async ({ ctx }) => {
  const userId = ctx.session.user.id; // ✅ User ID from session
  return await ctx.repo.playerProfile.findByUserId(userId);
});
```

### Checking Authentication Status

```typescript
// Client component
'use client';

import { useSession } from '@arki/auth';

export function UserProfile() {
  const { data: session, isLoading } = useSession();

  if (isLoading) return <div>Loading...</div>;
  if (!session) return <div>Not authenticated</div>;

  return <div>Hello, {session.user.name}!</div>;
}
```

### Guarding `@arki/http` routes (session deriver)

In a DOT app serving HTTP through `@arki/http`, a guard is just a typed
context deriver that resolves the session from the request cookies and
throws the coded 401 when there is none. Later handlers in the bundle see
`ctx.session` fully typed:

```typescript
import { derive, HTTP_ERROR_CODES, HttpError, routes } from '@arki/http';

// Inside a pip's boot — `auth` is the app's better-auth instance
// (injected as a need, or imported from the app's auth module).
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

Role checks compose the same way — a second deriver that reads
`ctx.session` and throws `403` (`HTTP_ERROR_CODES.forbidden`). Note that
derivers do NOT run for `mount()`ed handlers (oRPC/tRPC routers own their
per-request context) — this pattern is for `route.*` contract bindings.

## Features

### Supported Authentication Methods

- ✅ Email/Password (credentials)
- ✅ Google OAuth
- ✅ GitHub OAuth
- ✅ Magic Links (email)
- ✅ Account Linking (multiple sign-in methods per user)

### Security Features

- ✅ Password hashing (bcrypt)
- ✅ Session management
- ✅ CSRF protection
- ✅ Rate limiting
- ✅ Email verification
- ✅ Account linking with verification

## Best Practices

1. **Always reference User ID** in your application features, never Account ID
2. **Let better-auth manage accounts** - your app code rarely needs to interact with the Account table
3. **Use User table for profile data** - name, email, image, etc.
4. **Enable account linking** to allow users to add multiple sign-in methods
5. **Read the User vs Account guide** before building authentication-related features

## Related Packages

- `@arki/db` - Database schema and utilities
- `@arki/kv` - Key-value store (for sessions, rate limiting)
- `@arki/emails` - Email templates and sending

## License

Private - Arki Platform
