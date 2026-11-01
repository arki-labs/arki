import type { z } from 'zod';
import { expectTypeOf } from 'vitest';

import type { ClientIpSource } from '../types.js';
import type { clientIpSchema } from './client-key.js';

// `ClientIpSource` is the source type; the boot schema must match it exactly, both ways.
expectTypeOf<z.output<typeof clientIpSchema>>().toEqualTypeOf<ClientIpSource>();

// One or the other, never both.
// @ts-expect-error -- a header and the socket together.
export const both: ClientIpSource = { header: 'x-real-ip', from: 'socket' };
