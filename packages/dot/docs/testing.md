# Testing plugins

Two builders: `testPlugin` for one plugin against fakes, `testApp` for several
real plugins together. Both run the real kernel, so a test sees the same
order, the same teardown and the same errors as production.

`testPlugin` is the typed unit-test builder: satisfy a plugin's needs directly
with fakes — no real providers, no dependency chain — and the compiler
holds the same line it holds in production. A missing fake means `boot()`
does not compile; a fake of the wrong shape fails at the `.provide()`
call site:

```ts
import { isFailure } from '@arki/failure';
import { expect } from 'vitest';

import { plugin, service, token } from '@arki/dot';
import { testPlugin } from '@arki/dot/test-harness';

type Pg = { query(sql: string): Promise<unknown[]> };
type Kv = { get(key: string): Promise<string | null> };
const Db = token<Pg>()('shop.db');
const catalog = plugin({
  name: 'catalog',
  needs: { db: Db, cache: service<Kv>() },
  provides: {
    catalog: ({ db, cache }) => ({
      list: async () => ((await cache.get('catalog:empty')) ? [] : db.query('select * from products')),
    }),
  },
});
const fakeDb: Pg = { query: async () => [] };
const fakeKv: Kv = { get: async () => null };

const app = await testPlugin(catalog)
  .provide(Db, fakeDb) // token need
  .provide('cache', fakeKv) // anonymous need — wire key is the alias
  .boot();
if (isFailure(app)) throw new Error(app.code);

expect(await app.services.catalog.list()).toEqual([]);
await app.dispose();
```

The fakes are published by a synthetic first plugin, so lifecycle semantics
are the real kernel's — reverse-order teardown, lazy auto-dispose, and
`$config` all behave exactly as in production. `service.lazy<T>()` needs
accept a plain `T` fake (lifted automatically) or `lazyOf(value)`.

For integration tests across several real plugins, `testApp([...plugins])`
builds an app from a plugin tuple: `app.services` is typed from the plugins,
and a tuple that would not mount (a need before its provider, a wire key
provided twice) is a compile error on the argument. A runtime-built array
mounts with runtime validation only. `bootTestApp` is the one-line
boot-and-return variant.
