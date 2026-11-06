/** Identity-preserving schema for an oRPC operation. Reached only by the `./orpc` adapter entry. */
import { z } from 'zod';

import { is } from '@arki/schema';

import type { AnyOperation } from './orpc.js';

import { objectSchema } from './inspection.js';

/** Each path entry is checked once, retaining native array and accessor semantics. */
const operationPathSchema = z.custom<readonly string[]>(
  value => Array.isArray(value) && Array.prototype.every.call(value, (segment: unknown) => typeof segment === 'string'),
);
/** The public Operation type is the source; its phantom field has no runtime data. */
export const operationSchema = z.custom<AnyOperation>(value => {
  if (!is(value, objectSchema)) return false;
  const path: unknown = Reflect.get(value, 'path');
  const meta: unknown = Reflect.get(value, 'meta');
  return (
    is(path, operationPathSchema) &&
    Reflect.get(value, 'name') === Array.prototype.join.call(path, '.') &&
    is(meta, objectSchema)
  );
});
