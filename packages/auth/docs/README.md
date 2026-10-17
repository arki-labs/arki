# @arki/auth Documentation

This directory contains documentation for the `@arki/auth` package, which provides authentication utilities and configuration for Arki applications using better-auth.

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
│   └── README.md      # This file
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
