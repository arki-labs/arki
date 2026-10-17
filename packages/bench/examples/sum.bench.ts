// #region suite
import { compare, defineSuite } from '@arki/bench';

export default defineSuite({
  id: 'my-lib',
  groups: [
    compare({
      id: 'sum',
      title: 'Sum an array',
      contract: { id: 'sum/v1', description: 'the sum of the numbers' },
      inputs: [[1, 2, 3], [], [-1, 1], [0.1, 0.2]],
      expected: xs => xs.reduce((a, b) => a + b, 0),
      baseline: 'loop',
      cases: {
        loop: {
          run: (xs: number[]) => {
            let s = 0;
            for (const x of xs) s += x;
            return s;
          },
        },
        reduce: { run: (xs: number[]) => xs.reduce((a, b) => a + b, 0) },
      },
    }),
  ],
});
// #endregion suite
