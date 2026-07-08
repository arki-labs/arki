/**
 * Browser build of the contracts surface — selected by the `browser`
 * exports condition. Client bundles get the zod re-exports WITHOUT the
 * drizzle-zod table wrappers, so `import { z } from '@arki/contracts'`
 * in a shared contract module never drags `drizzle-orm` into a browser
 * bundle. Importing a table wrapper (`createSelectSchema`, …) from
 * client code fails loudly at bundle time with a missing-export error —
 * table schemas are server declarations and must stay server-side.
 */
export * as formData from 'zod-form-data';
export * from 'zod/v4';

/**
 * Same globally-registered symbol as the node build (`Symbol.for`
 * resolves to one value across module copies), so isomorphic code that
 * only TAGS or READS schema metadata keeps working in the browser.
 */
export const COLUMN_ZOD_SCHEMA: unique symbol = Symbol.for('@arki/contracts/columnZodSchema') as never;
