# User vs Account in better-auth

This document explains the fundamental distinction between "User" and "Account" entities in better-auth, a concept that is critical for understanding authentication flows in our applications.

## Overview

better-auth (like many modern authentication systems) separates **user identity** from **authentication methods**:

- **User** = The person/entity in your application (one per person)
- **Account** = A specific way to authenticate (multiple per user)

This separation enables flexible authentication while maintaining a clean user model.

## User Entity

The **User** table represents the canonical identity of a person in your system.

### Schema

```typescript
// Simplified user schema
{
  id: string;              // Unique user ID (e.g., "usr_abc123")
  name: string | null;     // Display name
  email: string;           // Primary email address
  emailVerified: boolean;  // Email verification status
  image: string | null;    // Profile image URL
  createdAt: Date;
  updatedAt: Date;
}
```

### Characteristics

- **One record per person** - Each user has exactly one User record
- **Profile information** - Contains user-facing data (name, email, image)
- **Canonical identity** - The "source of truth" for who someone is
- **Feature references** - Other features reference User ID (e.g., player profiles, game sessions)

### Example

```typescript
// User record
{
  id: "usr_abc123",
  name: "Alex Player",
  email: "alex@example.com",
  emailVerified: true,
  image: "https://cdn.example.com/avatar.jpg",
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

## Account Entity

The **Account** table represents a specific authentication method linked to a User.

### Schema

```typescript
// Simplified account schema
{
  id: string;                    // Unique account ID
  userId: string;                // References User.id
  accountId: string;             // Provider's ID for this user
  providerId: string;            // Auth provider (e.g., "google", "github", "credentials")
  accessToken: string | null;    // OAuth access token
  refreshToken: string | null;   // OAuth refresh token
  expiresAt: Date | null;        // Token expiration
  password: string | null;       // Hashed password (credentials provider only)
  scope: string | null;          // OAuth scopes
  tokenType: string | null;      // Token type (e.g., "Bearer")
}
```

### Characteristics

- **Multiple per user** - A user can have multiple accounts
- **Provider-specific** - Each account represents one authentication method
- **Authentication data** - Contains tokens, OAuth info, credentials
- **Managed by better-auth** - Your app code rarely interacts with accounts directly

### Example

```typescript
// User with multiple accounts
// User: usr_abc123

// Account 1: Email/Password
{
  id: "acc_xyz789",
  userId: "usr_abc123",
  providerId: "credentials",
  accountId: "alex@example.com",
  password: "$2a$10$...",  // Hashed password
  accessToken: null,
  refreshToken: null
}

// Account 2: Google OAuth
{
  id: "acc_def456",
  userId: "usr_abc123",
  providerId: "google",
  accountId: "1234567890",  // Google user ID
  password: null,
  accessToken: "ya29.a0...",
  refreshToken: "1//0g...",
  expiresAt: "2024-01-16T10:00:00Z",
  scope: "email profile",
  tokenType: "Bearer"
}

// Account 3: GitHub OAuth
{
  id: "acc_ghi123",
  userId: "usr_abc123",
  providerId: "github",
  accountId: "octocat",  // GitHub username
  accessToken: "gho_...",
  refreshToken: null
}
```

## Why This Separation?

### 1. Multiple Sign-In Methods

Users can authenticate through different providers while maintaining a single identity:

```typescript
// Same user, three sign-in options:
// 1. Email: alex@example.com + password
// 2. Google: "Sign in with Google"
// 3. GitHub: "Sign in with GitHub"

// All three methods authenticate to the same User (usr_abc123)
```

### 2. Account Linking

Users can add authentication methods to their existing account:

```typescript
// Sign-up flow:
1. User signs up with email/password
   → Creates User (usr_abc123)
   → Creates Credentials Account

2. Later, user links Google account
   → Creates Google Account linked to usr_abc123

3. User can now sign in with either method
```

### 3. OAuth Token Management

OAuth providers require storing provider-specific data:

```typescript
// Google Account stores Google-specific tokens
{
  providerId: "google",
  accessToken: "ya29.a0...",      // Use for Google API calls
  refreshToken: "1//0g...",        // Refresh when access token expires
  expiresAt: "2024-01-16T...",    // Token expiration time
  scope: "email profile openid"    // Granted permissions
}

// This data doesn't belong on the User record
// It's specific to the Google authentication method
```

### 4. Security Isolation

Separating accounts provides security benefits:

```typescript
// If one account is compromised (e.g., password leaked)
// User can still sign in with other accounts
// Compromised account can be removed without affecting user identity
```

## Practical Usage in Your Application

### Feature Development

When building features, **always reference User ID**, not Account ID:

```typescript
// ✅ CORRECT: Reference User ID
// features/player-profile/tables.ts
export const playerProfiles = pgTable('player_profiles', {
  userId: varchar('user_id', { length: 256 })
    .$type<UserId>()
    .notNull()
    .references(() => users.id),  // References User table
  displayName: varchar('display_name', { length: 100 }),
  // ... other profile fields
});

// ❌ WRONG: Don't reference Account ID
export const playerProfiles = pgTable('player_profiles', {
  accountId: varchar('account_id', { length: 256 })
    .$type<AccountId>()
    .notNull()
    .references(() => accounts.id),  // DON'T DO THIS
});
```

### Session Management

Sessions contain User ID, not Account ID:

```typescript
// When user signs in, session references User
{
  sessionToken: "ses_xyz...",
  userId: "usr_abc123",  // User ID in session
  expiresAt: "2024-01-30T10:00:00Z"
}

// Your tRPC context
{
  session: {
    user: {
      id: "usr_abc123",      // User ID available
      email: "alex@example.com",
      name: "Alex Player"
    }
  }
}
```

### Accessing User Data

In your procedures and repositories, work with User ID:

```typescript
// tRPC procedure
export const getPlayerProfile = protectedProcedure
  .input(z.object({ userId: userIdSchema }))
  .query(async ({ ctx, input }) => {
    // Use User ID to fetch profile
    return await ctx.repo.playerProfile.findByUserId(input.userId);
  });

// Repository method
async findByUserId(userId: UserId) {
  return await this.db
    .select()
    .from(playerProfiles)
    .where(eq(playerProfiles.userId, userId))  // Query by User ID
    .limit(1);
}
```

## Authentication Flows

### Sign-Up Flow

```typescript
// 1. User signs up with Google
POST /api/auth/sign-up/social
{
  provider: "google",
  code: "auth_code_from_google"
}

// better-auth creates:
// A. User record
{
  id: "usr_abc123",
  email: "alex@example.com",  // From Google profile
  name: "Alex Player",         // From Google profile
  image: "https://google.com/avatar.jpg",
  emailVerified: true
}

// B. Account record
{
  id: "acc_xyz789",
  userId: "usr_abc123",        // Links to User
  providerId: "google",
  accountId: "1234567890",     // Google user ID
  accessToken: "ya29...",
  refreshToken: "1//0g..."
}

// 2. Your app creates related records
// features/player-profile/procedures/create-profile.ts
{
  userId: "usr_abc123",        // References the User
  displayName: "Alex Player",
  gamesPlayed: 0
}
```

### Sign-In Flow

```typescript
// 1. User signs in with GitHub
POST /api/auth/sign-in/social
{
  provider: "github",
  code: "auth_code_from_github"
}

// better-auth:
// A. Finds Account with providerId="github" and accountId="octocat"
// B. Gets linked userId from Account (usr_abc123)
// C. Creates session with userId

// 2. Session created
{
  sessionToken: "ses_xyz...",
  userId: "usr_abc123",
  expiresAt: "2024-01-30T10:00:00Z"
}

// 3. Your app uses userId from session
const profile = await ctx.repo.playerProfile.findByUserId(ctx.session.user.id);
```

### Account Linking Flow

```typescript
// User already exists with email/password
// User: usr_abc123
// Account 1: Credentials provider

// User clicks "Link Google Account"
POST /api/auth/link-account
{
  provider: "google",
  code: "auth_code_from_google"
}

// better-auth creates new Account linked to existing User
{
  id: "acc_new123",
  userId: "usr_abc123",        // Same User ID
  providerId: "google",
  accountId: "9876543210",
  accessToken: "ya29...",
  refreshToken: "1//0g..."
}

// User can now sign in with either:
// - Email/password (Credentials Account)
// - Google (Google Account)
// Both authenticate to the same User (usr_abc123)
```

## Best Practices

### 1. Always Reference User ID in Features

```typescript
// ✅ CORRECT
export const gameSessions = pgTable('game_sessions', {
  userId: varchar('user_id', { length: 256 })
    .$type<UserId>()
    .references(() => users.id),
});

// ❌ WRONG
export const gameSessions = pgTable('game_sessions', {
  accountId: varchar('account_id', { length: 256 })
    .$type<AccountId>()
    .references(() => accounts.id),
});
```

### 2. Let better-auth Manage Accounts

Your application code should rarely interact with the Account table directly. better-auth handles:
- Creating accounts during sign-up
- Linking additional accounts
- Refreshing OAuth tokens
- Managing credentials

### 3. Use User Table for Profile Data

```typescript
// ✅ CORRECT: User-related data on User or related tables
{
  users: {
    id: "usr_abc123",
    email: "alex@example.com",
    name: "Alex Player"
  },
  playerProfiles: {
    userId: "usr_abc123",
    displayName: "Alex",
    level: 5
  }
}

// ❌ WRONG: Don't store user data on Account
{
  accounts: {
    userId: "usr_abc123",
    providerId: "google",
    displayName: "Alex",  // DON'T DO THIS
    level: 5              // DON'T DO THIS
  }
}
```

### 4. Support Account Linking

Enable users to add multiple sign-in methods:

```typescript
// In your auth configuration
export const auth = betterAuth({
  // ... other config
  accountLinking: {
    enabled: true,
    requireVerification: true  // Verify email before linking
  }
});
```

### 5. Handle Multiple Accounts Gracefully

When displaying user authentication methods:

```typescript
// tRPC procedure to get user's linked accounts
export const getLinkedAccounts = protectedProcedure
  .query(async ({ ctx }) => {
    // better-auth provides this functionality
    const accounts = await ctx.auth.getLinkedAccounts(ctx.session.user.id);

    return accounts.map(account => ({
      provider: account.providerId,
      linkedAt: account.createdAt,
      // Don't expose tokens or sensitive data
    }));
  });
```

## Common Pitfalls

### ❌ Storing User Data on Account

```typescript
// WRONG: Profile data on Account
{
  accounts: {
    userId: "usr_abc123",
    providerId: "google",
    playerLevel: 5,          // Should be in playerProfiles
    preferredGenre: "RPG"    // Should be in playerProfiles
  }
}
```

**Why it's wrong:** A user can have multiple accounts. Which account stores the "true" level?

### ❌ Referencing Account ID in Features

```typescript
// WRONG: Feature tables referencing Account
export const achievements = pgTable('achievements', {
  accountId: varchar('account_id', { length: 256 })
    .$type<AccountId>()
    .references(() => accounts.id),  // DON'T DO THIS
});
```

**Why it's wrong:** Achievements belong to the user, not to a specific authentication method.

### ❌ Querying by Account ID

```typescript
// WRONG: Looking up data by Account ID
async getPlayerStats(accountId: AccountId) {
  // This breaks if user has multiple accounts
  return await this.db
    .select()
    .from(playerStats)
    .where(eq(playerStats.accountId, accountId));
}

// CORRECT: Look up by User ID
async getPlayerStats(userId: UserId) {
  return await this.db
    .select()
    .from(playerStats)
    .where(eq(playerStats.userId, userId));
}
```

## Summary

| Aspect | User | Account |
|--------|------|---------|
| **Purpose** | Represents a person | Represents an authentication method |
| **Quantity** | One per person | Multiple per user |
| **Contains** | Profile data (name, email, image) | Auth data (tokens, credentials) |
| **Referenced By** | Your app features (profiles, sessions, game data) | better-auth internally |
| **Managed By** | Your app + better-auth | better-auth |
| **Example ID** | `usr_abc123` | `acc_xyz789` |

### Key Takeaways

1. **User = Identity**: One user record per person, contains profile information
2. **Account = Auth Method**: Multiple accounts per user, each for different sign-in methods
3. **Always reference User ID** in your features and database relations
4. **Let better-auth manage Accounts** - your app code rarely needs to touch them
5. **Enable account linking** to provide flexible authentication options

By maintaining this separation, you get:
- Flexible authentication (multiple sign-in methods)
- Clean data model (user data separate from auth data)
- Better security (isolate auth methods)
- Easier maintenance (clear responsibilities)

## Further Reading

- [better-auth Documentation](https://www.better-auth.com/docs)
- [OAuth 2.0 Specification](https://oauth.net/2/)
- [Account Linking Best Practices](https://www.better-auth.com/docs/concepts/account-linking)
