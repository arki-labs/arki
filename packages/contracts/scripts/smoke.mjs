// Cross-runtime smoke test for the BUILT entries (dist/). Runs under Node,
// Bun and Deno via `bun run test:runtimes`, and is bundled for the browser and
// Hermes targets. It imports the main entry and the `/orpc` entry, which needs
// the optional peer `@orpc/contract`.

import { oc } from '@orpc/contract';

import { keyset, page, pageInput, z } from '../dist/index.js';
import { OPERATION, operationAt, operationOf, operations } from '../dist/orpc.js';

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`smoke check failed: ${message}`);
  checks += 1;
}

// Keyset pagination: a cursor round-trips and the page schemas parse.
const order = keyset({ createdAt: 'desc', id: 'desc' });
const createdAt = new Date('2026-10-15T08:00:00.000Z');
const cursor = order.encode({ createdAt, id: 'sty_b' });
check(order.decode(cursor).createdAt.getTime() === createdAt.getTime(), 'a cursor round-trips a Date');
check(pageInput(order).parse({}).limit === 20, 'pageInput defaults the limit to 20');
check(page(z.string()).parse({ items: ['a'], nextCursor: null }).items[0] === 'a', 'page parses');

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

console.log(`${checks} smoke checks passed`);
