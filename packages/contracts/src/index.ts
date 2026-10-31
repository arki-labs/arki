/**
 * Browser-safe schema tools: Zod, form data, prefixed ids, keyset pagination and coded errors.
 *
 * Zod and `zod-form-data` are re-exported unchanged, so their `.parse()` throws a raw `ZodError` on bad input and
 * `formData.formData(...)` schemas do the same. For outside values (a request, a stored payload, user text) use
 * `parse` or `safeParse` from `@arki/schema`, which return an `InvalidInput` failure, or Zod's own `.safeParse()`.
 * The Arki doors in this package (`defineId().is`, the keyset cursor decoder, `operationAt`) never throw on outside values.
 * Builders such as `defineId` throw `ContractsError` for a wrong declaration, which is a bug in the caller.
 */
export * as formData from 'zod-form-data';
export * from 'zod';
export * from './ids.js';
export * from './pagination.js';
export * from './errors.js';
