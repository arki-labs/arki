/**
 * The auth id kinds, each declared once with `defineId`. Internal: `./ids` exports the types and
 * generators, `./zod` the schemas, `./pg` the columns. Not exported as declarations, because a
 * declaration's type carries `z.ZodType` and the browser-safe entries must not.
 */
import { defineId } from '@arki/contracts';

export const userId = defineId('usr_');
export const sessionId = defineId('sess_');
export const accountId = defineId('acc_');
export const verificationId = defineId('verif_');
export const organizationId = defineId('organization_');
export const teamId = defineId('team_');
