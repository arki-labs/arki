import {
  assertContainsId,
  assertErrorThrown,
  assertPaginationValid,
  createFactory,
  createMany,
  faker,
} from '@arki/testing';

// #region factory
type User = { id: string; email: string; role: 'member' | 'admin' };

const userFactory = createFactory<User>(() => ({
  id: `usr_${faker.string.alphanumeric(8)}`,
  email: faker.internet.email(),
  role: 'member',
}));

const member = userFactory({ email: 'member@example.com' });
const admin = userFactory().with('role', 'admin').build();
const team = createMany(userFactory, 3, index => ({ email: `user${index}@example.com` }));
// #endregion factory

// #region assertions
const page = { items: [member, admin, ...team], total: 5, hasMore: false };

assertPaginationValid(page, { itemsCount: 5, total: 5, hasMore: false });
assertContainsId(page.items, admin.id);
await assertErrorThrown(() => Promise.reject(new Error('user not found')), /not found/);
// #endregion assertions

console.log(`${String(page.items.length)} users, admin is ${admin.role}`);
