# @arki/auth Documentation

This directory contains documentation for the `@arki/auth` package, which provides authentication utilities and configuration for Arki applications using better-auth.

## Documentation Files

### [User vs Account](./USER_VS_ACCOUNT.md)
**Essential reading for understanding authentication.**

Explains the fundamental distinction between "User" (identity) and "Account" (authentication method) entities in better-auth. This is critical for:
- Building features that reference the correct entity (always User, not Account)
- Understanding authentication flows (sign-up, sign-in, account linking)
- Avoiding common pitfalls (storing user data on accounts, referencing account IDs)

**Read this first if you're:**
- Building new features that need to reference users
- Implementing authentication flows
- Confused about when to use `userId` vs `accountId`

## Quick Reference

### Common Questions

**Q: Should my feature reference `userId` or `accountId`?**
A: Always `userId`. Features belong to users, not to authentication methods.

**Q: Can a user have multiple accounts?**
A: Yes! A user can sign in with email/password, Google, GitHub, etc. All link to the same user.

**Q: Where do I store user profile data?**
A: On the `User` table or related feature tables (like `playerProfiles`), never on `Account`.

**Q: When do I interact with the `Account` table?**
A: Rarely. better-auth manages accounts internally. Your app works with users.

## Package Structure

```
packages/auth/
├── docs/              # This directory
│   ├── README.md      # This file
│   └── USER_VS_ACCOUNT.md
├── src/
│   ├── dot.config.ts  # better-auth configuration
│   ├── env.ts         # Environment variables
│   ├── ids.ts         # ID generation utilities
│   ├── password.ts    # Password utilities
│   └── security/      # Security utilities
└── package.json
```

## Related Documentation

- [better-auth Official Docs](https://www.better-auth.com/docs)
- [Feature-Based Organization (Backend)](../../../.github/instructions/backend/feature-based-organization-backend.instructions.md)
- [tRPC API Patterns](../../../.github/instructions/backend/trpc-api-patterns.instructions.md)
