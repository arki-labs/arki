import { createId } from '@paralleldrive/cuid2';

/**
 * Same shape as `createPrefixedId` in `@arki/db/id`. That module is not
 * imported because its value export pulls `drizzle-orm/pg-core` and
 * `@arki/contracts` into browser bundles.
 */
const prefixed = <P extends string>(prefix: P): `${P}${string}` => `${prefix}${createId()}`;

export const eventId = () => prefixed('evt_');
export const jobId = () => prefixed('job_');
export const leaseToken = () => createId();
