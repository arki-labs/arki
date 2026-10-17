Back to the [README](../../README.md#documentation).

# @arki/math/random

```ts
import { createRandom, randomInt, sample, shuffle } from '@arki/math/random';

randomInt(1, 6); // 1–6, both ends included, unbiased
shuffle([1, 2, 3, 4]); // a new array; the input is untouched
sample(['a', 'b', 'c', 'd'], 2); // two distinct picks

const rng = createRandom('level-7'); // seeded: the same sequence every run
rng.int(1, 100);
rng.gaussian(0, 1);
rng.pick(['rock', 'paper', 'scissors']);
```

Unseeded generators draw from `crypto.getRandomValues` when the runtime has
it (Node 19+, Bun, Deno, browsers) and fall back to `Math.random`. Seeded
generators use xoshiro128\*\*, deterministic across runtimes.
