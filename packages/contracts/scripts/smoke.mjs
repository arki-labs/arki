// Cross-runtime smoke test for the BUILT entries (dist/). Runs under Node,
// Bun and Deno via `bun run test:runtimes`, and is bundled for the browser and
// Hermes targets. It imports the main entry and the `/orpc` entry, which needs
// the optional peer `@orpc/contract`.

import { oc } from '@orpc/contract';
import { pgTable } from 'drizzle-orm/pg-core';

import { isFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import { createInsertSchema, createSelectSchema, createUpdateSchema, jsonColumn } from '../dist/drizzle.js';
import {
  defineId,
  formData,
  InvalidCursor,
  InvalidCursorValue,
  keyset,
  page,
  pageInput,
  RandomSourceUnavailable,
  z,
} from '../dist/index.js';
import { OPERATION, operationAt, operationOf, operations } from '../dist/orpc.js';

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
  checks += 1;
}

// Keyset pagination: a cursor round-trips and the page schemas parse.
const order = keyset({ createdAt: 'desc', id: 'desc' });
const createdAt = new Date('2026-10-15T08:00:00.000Z');
const cursor = orThrow(order.encode({ createdAt, id: 'sty_b' }));
check(orThrow(order.decode(cursor)).createdAt.getTime() === createdAt.getTime(), 'a cursor round-trips a Date');
check(pageInput(order).parse({}).limit === 20, 'pageInput defaults the limit to 20');
check(page(z.string()).parse({ items: ['a'], nextCursor: null }).items[0] === 'a', 'page parses');

// A non-ASCII cursor decodes on every engine (Hermes has no TextDecoder).
const byName = keyset({ name: 'asc', id: 'asc' });
check(
  orThrow(byName.decode(orThrow(byName.encode({ name: 'Ștefan 🎯', id: 'u_1' })))).name === 'Ștefan 🎯',
  'a non-ASCII key round-trips through the cursor',
);
check(InvalidCursor.is(order.decode('not a cursor')), 'a foreign cursor returns a canonical failure');
check(
  InvalidCursorValue.is(byName.encode({ name: NaN, id: 'u_1' })),
  'non-finite cursor keys return a canonical failure',
);

// Ids: a prefixed schema, and a random id from globalThis.crypto.
const storyId = defineId('sty_');
check(storyId.schema.safeParse('sty_abc').success, 'an id with its prefix parses');
check(!storyId.schema.safeParse('usr_abc').success, 'an id with another prefix is rejected');
// Hermes has no crypto; generation returns canonical unavailability there.
const generatedId = storyId.create();
if (typeof globalThis.crypto?.getRandomValues === 'function') {
  check(orThrow(generatedId).startsWith('sty_'), 'create() makes an id with the prefix');
} else {
  check(RandomSourceUnavailable.is(generatedId), 'create() without crypto returns canonical unavailability');
}

// UUID generation prefers randomUUID and can use secure random bytes instead.
const jobId = defineId('', { kind: 'queue.job', format: 'uuid' });
check(jobId.schema.parse('customer:job/42') === 'customer:job/42', 'UUID domains restore external job keys');
const generatedJobId = jobId.create();
if (typeof globalThis.crypto?.randomUUID === 'function' || typeof globalThis.crypto?.getRandomValues === 'function') {
  check(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(orThrow(generatedJobId)),
    'UUID generation returns UUID v4 from Web Crypto',
  );
} else {
  check(
    RandomSourceUnavailable.is(generatedJobId),
    'UUID generation without secure providers returns canonical unavailability',
  );
}

// Controlled foreign-provider fixtures exercise the fallback even on native UUID engines.
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const fallbackCrypto = {
  getRandomValues(bytes) {
    check(this === fallbackCrypto, 'UUID fallback retains the provider receiver');
    check(bytes.byteLength === 16, 'UUID fallback requests exactly 16 bytes');
    return bytes.fill(255);
  },
};
try {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: fallbackCrypto });
  check(jobId.create() === 'ffffffff-ffff-4fff-bfff-ffffffffffff', 'UUID fallback sets version and variant bits');
  check(jobId.schema.parse('legacy:job') === 'legacy:job', 'fallback preserves prefix-only stored schemas');

  const nativeUuid = '01234567-89AB-4CDE-8F01-23456789ABCD';
  const nativeCrypto = {
    randomUUID() {
      check(this === nativeCrypto, 'native UUID retains the provider receiver');
      return nativeUuid;
    },
    getRandomValues() {
      throw new Error('Do not invoke fallback for an available native UUID');
    },
  };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: nativeCrypto });
  check(jobId.create() === nativeUuid, 'native UUID bytes take precedence and retain their case');
  nativeCrypto.randomUUID = () => 'invalid';
  check(UnexpectedDefect.is(jobId.create()), 'malformed native UUID is a defect without fallback');
  const cause = new Error('private provider details');
  nativeCrypto.randomUUID = () => {
    throw cause;
  };
  const failedNative = jobId.create();
  check(UnexpectedDefect.is(failedNative), 'thrown native UUID is a defect without fallback');
  check(isFailure(failedNative) && failedNative.cause === cause, 'UUID defects retain their private cause');
  check(!JSON.stringify(failedNative).includes('private provider'), 'UUID defects omit private causes from JSON');

  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
  check(RandomSourceUnavailable.is(jobId.create()), 'UUID without either provider is unavailable');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: () => new Uint8Array(16) },
  });
  check(UnexpectedDefect.is(jobId.create()), 'UUID fallback rejects a different returned buffer');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { getRandomValues: () => Promise.reject(cause) },
  });
  check(UnexpectedDefect.is(jobId.create()), 'asynchronous fallback returns a synchronous defect');
  // Let a rejected foreign provider surface if the library forgot to observe it.
  await Promise.resolve();
  await Promise.resolve();
} finally {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  else Reflect.deleteProperty(globalThis, 'crypto');
}

// zod-form-data loads on every engine. Plain Hermes has no FormData class (React Native adds one), so parsing runs where it exists.
const formSchema = formData.formData({ title: formData.text(), count: formData.numeric() });
check(typeof formSchema.parse === 'function', 'zod-form-data builds a schema');
if (typeof FormData === 'function') {
  const form = new FormData();
  form.set('title', 'Hi');
  form.set('count', '3');
  const parsed = formSchema.parse(form);
  check(parsed.title === 'Hi' && parsed.count === 3, 'zod-form-data parses a FormData');
}

// Operations: one identity per contract procedure.
const contract = {
  posts: {
    list: oc.input(pageInput(order)).output(page(z.string())),
    create: oc.$meta({ offlineSafe: true }).input(z.object({ title: z.string() })),
  },
};
const ops = operations(contract);
check(ops.posts.create.name === 'posts.create', 'the name joins the path with "."');
check(ops.posts.create.meta.offlineSafe === true, 'the meta comes from the contract');
check(Object.isFrozen(ops.posts.list), 'an operation is frozen');
check(operationAt(contract, ['posts', 'list'])?.name === 'posts.list', 'operationAt finds a leaf');
check(operationOf({ [OPERATION]: ops.posts.list }) === ops.posts.list, 'operationOf reads the carrier');
let threw = false;
try {
  operations({ posts: { 'by.id': oc.output(z.string()) } });
} catch (error) {
  threw = error instanceof TypeError;
}
check(threw, 'a key with "." throws TypeError');

// JSON storage metadata rejects nested values on every supported engine.
const profileSchema = z.object({ age: z.number(), groups: z.array(z.array(z.string())).optional() });
const profiles = pgTable('profiles', { profile: jsonColumn('profile', profileSchema).notNull() });
for (const schema of [createSelectSchema(profiles), createInsertSchema(profiles), createUpdateSchema(profiles)]) {
  check(!schema.safeParse({ profile: { age: 'wrong' } }).success, 'nested JSON age is checked');
  check(!schema.safeParse({ profile: { age: 1, groups: [[2]] } }).success, 'nested JSON arrays are checked');
  check(schema.safeParse({ profile: { age: 1 } }).success, 'valid JSON storage parses');
}
const storedCount = z.number();
const countWire = z.codec(z.string(), storedCount, { decode: Number, encode: String });
const counts = pgTable('counts', { count: jsonColumn('count', storedCount).notNull() });
const parsedCount = createInsertSchema(counts, { count: () => countWire }).parse({ count: '42' });
check(parsedCount.count === 42, 'wire codec produces application output');
check(createSelectSchema(counts).parse(parsedCount).count === 42, 'stored output uses the stable storage schema');

const phantom = pgTable('phantom', { value: jsonColumn('value', z.number()).notNull() });
check(
  !createSelectSchema(pgTable('nan', { value: jsonColumn('value', z.nan()).notNull() })).safeParse({ value: NaN })
    .success,
  'non-finite storage output is rejected',
);
const narrowed = z.object({ id: storyId.schema, count: z.number().default(1) });
const narrowedRows = pgTable('narrowed', { value: jsonColumn('value', narrowed).notNull() });
check(
  createSelectSchema(narrowedRows).parse({ value: { id: 'sty_abc' } }).value.count === 1,
  'narrowed storage schemas accept their parsed output',
);
check(createSelectSchema(phantom).parse({ value: 42 }).value === 42, 'JSON scalar output survives storage validation');
console.log(`${checks} smoke checks passed`);
