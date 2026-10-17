// Cross-runtime smoke test, run by `bun run test:runtimes` under Node, Bun, Deno and a browser.
// It loads the portable entries (`.`, `./ids`, `./zod`, `./password`, `./workspaces`) through the
// package's own export map, so it checks what a consumer gets. The unit tests cover the details.

import {
  AUTH_ERROR_CODES,
  AUTH_SECRET_MIN_LENGTH,
  AuthError,
  defineAuth,
  definePolicies,
  isAuthError,
  PASSWORD_MIN_LENGTH,
} from '@arki/auth';
import { createUserId } from '@arki/auth/ids';
import { hashPassword, verifyPassword } from '@arki/auth/password';
import { rankRole, roleAtLeast, scopeLevel, WorkspaceScopeError } from '@arki/auth/workspaces';
import { userIdSchema } from '@arki/auth/zod';

const errorOf = run => {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
};

const definition = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'google'] });
const unknownMethod = errorOf(() => defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['fax'] }));
const badKey = errorOf(() => defineAuth({ app: { name: 'Notes', key: 'Not A Key' }, methods: ['password'] }));
const refusal = new AuthError(AUTH_ERROR_CODES.unauthenticated, 'Sign in to continue.');

const hash = await hashPassword('correct horse battery staple');
const rightPassword = await verifyPassword({ hash, password: 'correct horse battery staple' });
const wrongPassword = await verifyPassword({ hash, password: 'correct horse battery stable' });
const malformedHash = await verifyPassword({ hash: 'not-a-hash', password: 'anything' });

const userId = createUserId();

const orderPolicies = definePolicies()({ order: { refund: ({ order }) => order.status !== 'shipped' } });

const illegalScope = errorOf(() => scopeLevel({ organizationId: null, teamId: 'team_1' }));

const checks = [
  ['defineAuth returns the definition unchanged', definition.methods.join(','), 'password,google'],
  ['an unknown method is E001', isAuthError(unknownMethod) && unknownMethod.code, AUTH_ERROR_CODES.invalidConfig],
  ['a bad app key is E001', isAuthError(badKey) && badKey.code, AUTH_ERROR_CODES.invalidConfig],
  ['E401 answers with status 401', refusal.status, 401],
  ['definePolicies keeps the tree as written', orderPolicies.tree.order.refund({ order: { status: 'open' } }), true],
  ['E008 answers with status 500', new AuthError(AUTH_ERROR_CODES.policyNotDeclared, 'x').status, 500],
  ['passwords have at least 8 characters', PASSWORD_MIN_LENGTH, 8],
  ['secrets have at least 32 characters', AUTH_SECRET_MIN_LENGTH, 32],
  ['a hash is <salt hex>:<key hex>', /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash), true],
  ['the right password verifies', rightPassword, true],
  ['a wrong password does not verify', wrongPassword, false],
  ['a malformed hash is false, not a throw', malformedHash, false],
  ['admin is at least member', roleAtLeast('admin', 'member'), true],
  ['member is not at least admin', roleAtLeast('member', 'admin'), false],
  ['no role ranks below member', rankRole(null) < rankRole('member'), true],
  ['an empty scope is personal', scopeLevel({ organizationId: null, teamId: null }), 'personal'],
  ['a team without an organization is refused', illegalScope instanceof WorkspaceScopeError, true],
  ['a user id is usr_ and 24 letters and digits', /^usr_[a-z][a-z0-9]{23}$/.test(userId), true],
  ['userIdSchema accepts a made user id', userIdSchema.parse(userId), userId],
  ['userIdSchema refuses another kind', userIdSchema.safeParse('sess_abc').success, false],
];

const runtime =
  typeof Deno !== 'undefined'
    ? `deno ${Deno.version.deno}`
    : typeof Bun !== 'undefined'
      ? `bun ${Bun.version}`
      : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
        ? `browser ${navigator.userAgent}`
        : `node ${globalThis.process?.versions?.node}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
