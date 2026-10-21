Back to the [README](../../README.md#documentation).

# @arki/math/finance

Spreadsheet-shaped (Excel `PMT`, `NPV`, `IRR`, `FV`, `PV`, `EFFECT`,
`NOMINAL`) but exact on `Decimal`: rates are per-period fractions, every
intermediate stays exact and the result is rounded once at the scale you
ask for. `payment` returns a positive number for a positive loan.

```ts
import { amortizationSchedule, futureValue, netPresentValue, payment } from '@arki/math/finance';

payment(200_000, 0.005, 360, { scale: 2, rounding: 'halfEven' }).toString(); // '1199.10'
futureValue(1000, 0.05, 10).toString(); // exact: '1628.89462677744140625000'
netPresentValue(0.1, [100, 100, 100], { scale: 2 }).toString(); // '248.69'
amortizationSchedule(1000, 0.01, 12, { scale: 2 }).at(-1)?.balance.toString(); // '0.00'
```

`futureValue` and `presentValue` take `{ payment, timing }` for annuities
(Excel `FV`/`PV` with a payment, `timing: 'begin'` for type 1). Results are
balances, so `futureValue(pv, r, n, { payment })` is `-FV(r, n, payment, pv)`.

`@arki/math/finance/float` has the same functions, names and sign rules on
`number`, for what the exact layer cannot do: fractional or negative periods,
horizons whose exact powers pass the digit limit, and tight loops. `(1+r)^n`
goes through `log1p`/`expm1`, so tiny rates stay accurate and rate `0` is
exact. `periodsToReach` (in both paths; it needs a logarithm, so it is always
float) takes `{ payment }` like Excel `NPER`.

```ts
import { futureValue, payment, periodsToReach } from '@arki/math/finance/float';

payment(200_000, 0.05 / 12, 360); // 1073.6432460242777
futureValue(1000, 0.05, 7.5); // 1441.8488753719537   fractional periods
periodsToReach(5000, 0, 0.18 / 12, { payment: -200 }); // 31.56…   months to pay off a card
```
