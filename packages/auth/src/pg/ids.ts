/**
 * The Drizzle columns of the auth id kinds, for the app's own tables: `userIdColumns.primaryColumn()`,
 * `userIdColumns.createForeignKeyFactory(() => User.id)`, `userIdColumns.reference('user_id')`.
 *
 * Column helpers only. Make ids with `create*Id` from `@arki/auth/ids`; check them with the
 * schemas on `@arki/auth/zod`.
 */
import { idColumns } from '@arki/db/id-factory';

import {
  accountIdFactory as accountIdSource,
  permissionIdFactory as permissionIdSource,
  roleIdFactory as roleIdSource,
  sessionIdFactory as sessionIdSource,
  userIdFactory as userIdSource,
  userVerificationIdFactory as verificationIdSource,
} from '../ids.js';

export const userIdColumns = idColumns(userIdSource);
export const sessionIdColumns = idColumns(sessionIdSource);
export const accountIdColumns = idColumns(accountIdSource);
export const verificationIdColumns = idColumns(verificationIdSource);
export const roleIdColumns = idColumns(roleIdSource);
export const permissionIdColumns = idColumns(permissionIdSource);
