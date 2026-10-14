# Reference fixtures

These files are independent reference data for `@arki/math`'s accuracy tests.
They are for development only. `package.json` `files` publishes `dist`, `src`
(without tests), the README and the licence, so nothing here reaches npm.

| fixture                       | generator              | reference                                           | read by                               |
| ----------------------------- | ---------------------- | --------------------------------------------------- | ------------------------------------- |
| `fixtures/decimal-math.json`  | `gen_decimal_math.py`  | mpmath (adaptive precision) and exact integer roots | `src/decimal-math.reference.test.ts`  |
| `fixtures/distributions.json` | `gen_distributions.py` | mpmath at 50 digits                                 | `src/distributions.reference.test.ts` |
| `fixtures/nist-strd.json`     | `gen_nist.py`          | NIST StRD certified values (public domain)          | `src/stats.reference.test.ts`         |

`ERROR-ANALYSIS.md` is the written proof behind `ERROR_BOUND = 2n`, the bound
that Decimal's correct rounding rests on.

## Regenerate

The generators are seeded and deterministic. Run them from this directory:

```sh
python3 -m venv /tmp/refenv
/tmp/refenv/bin/pip install -r requirements.txt
/tmp/refenv/bin/python gen_decimal_math.py    # < 1 s
/tmp/refenv/bin/python gen_distributions.py   # about 45 s
python3 gen_nist.py                           # downloads from itl.nist.gov; no dependencies
```

To build the NIST fixture from local copies of the `.dat` files, pass their
directory: `python3 gen_nist.py path/to/dats`.

Then run the tests from `packages/math`: `bun run test`. The reference tests
together take well under a second.

## What the tests assert

- **decimal-math:** every case matches exactly, in all 8 rounding modes. The
  cases are random inputs at random scales 1–100, near-tie inputs built to sit
  within `10^-(scale + 14)` to `10^-(scale + 90)` of a rounding boundary, roots
  that land exactly on a tie, and exact logarithms and powers. For an inexact
  value, `unnecessary` must throw.
- **distributions:** each function's largest error over its reference points
  stays within the bound published in the README's Accuracy table. The bounds
  are listed in `BOUNDS` in the test. Discrete quantiles must match exactly.
- **NIST StRD:** each certified value matches to at least the published number
  of digits (LRE). The Decimal mean and stddev must reproduce the certified
  values digit for digit.

When a change makes a function more accurate, tighten its bound in the test
and in the README together. When a bound has to loosen, treat it as a
regression and find the cause first.
