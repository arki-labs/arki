/**
 * The Drizzle columns of the auth id kinds, for the app's own tables: `userIdColumns.primaryColumn()`,
 * `userIdColumns.createForeignKeyFactory(() => User.id)`, `userIdColumns.reference('user_id')`.
 *
 * Column helpers only. Make ids with `create*Id` from `@arki/auth/ids`; check them with the
 * schemas on `@arki/auth/zod`.
 */
import { idColumns } from '@arki/db/id-factory';

import { accountId, permissionId, roleId, sessionId, userId, verificationId } from '../id-declarations.js';

export const userIdColumns = idColumns(userId);
export const sessionIdColumns = idColumns(sessionId);
export const accountIdColumns = idColumns(accountId);
export const verificationIdColumns = idColumns(verificationId);
export const roleIdColumns = idColumns(roleId);
export const permissionIdColumns = idColumns(permissionId);
