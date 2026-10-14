#!/usr/bin/env python3
"""Reference values for @arki/math/decimal-math.

Writes fixtures/decimal-math.json. Every expected result is the true value
rounded once at `scale`, in each rounding mode:

- Roots are exact: integer n-th roots on Python ints, checked r^n <= R < (r+1)^n.
- exp, ln, log, pow come from mpmath inside a Ziv loop: the value is computed
  at increasing precision until both ends of its error interval round the same
  way in every mode. The interval is widened for the input's own rounding to
  binary (the condition number of the function times 2^-prec).

Each case stores the floor of value x 10^scale as a decimal string and an
8-character offset string, one character per mode in MODES order: the
expected coefficient is floor + offset; 'x' means the mode must throw
(only `unnecessary`, when the value is not exact at that scale).

Cases: random inputs at random scales 1-100, plus deliberate near-tie cases
whose true value sits just above or below a rounding boundary (the half-way
point for the half modes, a representable value for the directed modes), so
the library's Ziv loop has to retry with more guard digits, and exact
boundary cases (a root that lands exactly on a tie).
"""

import json
import random
import sys
from fractions import Fraction
from pathlib import Path

import mpmath as mp

MODES = ['up', 'down', 'ceiling', 'floor', 'halfUp', 'halfDown', 'halfEven', 'unnecessary']
SEED = 20261014
rng = random.Random(SEED)


# ---------------------------------------------------------------------------
# Exact rounding of a rational
# ---------------------------------------------------------------------------


def floor_div(q: Fraction) -> int:
    return q.numerator // q.denominator


def round_at(q: Fraction, scale: int, mode: str):
    """q x 10^scale rounded to an integer by `mode`; None when `unnecessary` would throw."""
    v = q * 10**scale
    fl = floor_div(v)
    rem = v - fl
    if rem == 0:
        return fl
    ce = fl + 1
    positive = v > 0
    if mode == 'unnecessary':
        return None
    if mode == 'floor':
        return fl
    if mode == 'ceiling':
        return ce
    if mode == 'down':
        return fl if positive else ce
    if mode == 'up':
        return ce if positive else fl
    half = Fraction(1, 2)
    if rem < half:
        return fl
    if rem > half:
        return ce
    if mode == 'halfUp':
        return ce if positive else fl
    if mode == 'halfDown':
        return fl if positive else ce
    if mode == 'halfEven':
        return fl if fl % 2 == 0 else ce
    raise ValueError(mode)


def encode(results, scale_value_floor):
    offsets = ''.join('x' if r is None else str(r - scale_value_floor) for r in results)
    assert all(c in '01x' for c in offsets), offsets
    return offsets


def expected_from_rational(q: Fraction, scale: int):
    """Floor and offsets for a value known exactly (or represented by a point strictly inside its unit cell)."""
    results = [round_at(q, scale, m) for m in MODES]
    fl = floor_div(q * 10**scale)
    return str(fl), encode(results, fl)


# ---------------------------------------------------------------------------
# Decimal strings
# ---------------------------------------------------------------------------


def fmt(coefficient: int, scale: int) -> str:
    sign = '-' if coefficient < 0 else ''
    digits = str(abs(coefficient))
    if scale <= 0:
        return sign + digits + '0' * (-scale)
    digits = digits.rjust(scale + 1, '0')
    return f'{sign}{digits[:-scale]}.{digits[-scale:]}'


def to_fraction(text: str) -> Fraction:
    return Fraction(text)


def random_decimal(min_exp: int, max_exp: int, max_digits: int = 25, signed: bool = False) -> str:
    """A random decimal with 1..max_digits significant digits and magnitude 10^[min_exp, max_exp)."""
    digits = rng.randint(1, max_digits)
    coefficient = rng.randint(10 ** (digits - 1), 10**digits - 1)
    exponent = rng.randint(min_exp, max_exp - 1)  # value ~ 10^exponent
    scale = digits - 1 - exponent
    if signed and rng.random() < 0.5:
        coefficient = -coefficient
    return fmt(coefficient, scale)


def fraction_to_decimal(q: Fraction, fraction_digits: int) -> str:
    """q rounded half-even to `fraction_digits` digits, as a decimal string (used to build inputs)."""
    v = q * 10**fraction_digits
    return fmt(round(v), fraction_digits)


def mpf_to_fraction(v) -> Fraction:
    v = mp.mpf(v)
    man, exp = v.man_exp  # man is the magnitude; the sign is separate
    magnitude = Fraction(abs(man)) * Fraction(2) ** exp
    return -magnitude if v < 0 else magnitude


# ---------------------------------------------------------------------------
# Exact integer roots
# ---------------------------------------------------------------------------


def iroot(value: int, n: int) -> int:
    """floor(value^(1/n)) for value >= 0."""
    if value < 2:
        return value
    x = 1 << ((value.bit_length() + n - 1) // n)  # >= the root
    while True:
        y = ((n - 1) * x + value // x ** (n - 1)) // n
        if y >= x:
            break
        x = y
    while x**n > value:
        x -= 1
    while (x + 1) ** n <= value:
        x += 1
    assert x**n <= value < (x + 1) ** n
    return x


def root_reference(text: str, n: int, scale: int):
    q = to_fraction(text)
    magnitude = abs(q)
    working = scale + 2
    # floor(|q|^(1/n) x 10^working), exactly: |q| x 10^(n x working) is a fraction a/b.
    scaled = magnitude * 10 ** (n * working)
    # floor of the root of a fraction: floor(root(floor(a/b)))... is exact because
    # root is monotone and the integer part of the root only depends on floor(a/b).
    r = iroot(floor_div(scaled), n)
    exact = Fraction(r) ** n == scaled
    representative = Fraction(r) if exact else Fraction(2 * r + 1, 2)  # strictly inside the cell
    value = representative / 10**working
    if q < 0:
        value = -value
    return expected_from_rational(value, scale)


# ---------------------------------------------------------------------------
# Transcendental functions through a Ziv loop on mpmath
# ---------------------------------------------------------------------------


def transcendental_reference(fn: str, args, scale: int):
    """args are decimal strings. Returns (floor, offsets)."""

    def evaluate():
        xs = [mp.mpf(a) for a in args]
        if fn == 'exp':
            (x,) = xs
            return mp.exp(x), abs(x)
        if fn == 'ln':
            (x,) = xs
            v = mp.log(x)
            return v, 1 / abs(v)
        if fn == 'log10':
            (x,) = xs
            v = mp.log10(x)
            return v, 1 / abs(mp.log(x))
        if fn == 'log2':
            (x,) = xs
            v = mp.log(x, 2)
            return v, 1 / abs(mp.log(x))
        if fn == 'log':
            x, b = xs
            v = mp.log(x) / mp.log(b)
            return v, 1 / abs(mp.log(x)) + 1 / abs(mp.log(b))
        if fn == 'pow':
            b, y = xs
            v = mp.power(b, y)
            return v, abs(y * mp.log(b)) + abs(y)
        raise ValueError(fn)

    with mp.workdps(30):
        estimate, _ = evaluate()
        magnitude = int(mp.floor(mp.log10(abs(estimate)))) + 1 if estimate != 0 else 0
    dps = scale + max(magnitude, 0) + 40
    while dps <= 8000:
        with mp.workdps(dps):
            v, condition = evaluate()
            prec = mp.mp.prec
            q = mpf_to_fraction(v)
            # mpmath's own error (a few ulps) plus the inputs' binary rounding, amplified by the condition number.
            slack = mpf_to_fraction(abs(v) * (256 + 256 * condition) * mp.mpf(2) ** (-prec))
        low = [round_at(q - slack, scale, m) for m in MODES]
        high = [round_at(q + slack, scale, m) for m in MODES]
        if low[:-1] == high[:-1]:
            DISTANCES.append((fn, distance_to_boundary(q, scale)))
            fl = floor_div((q - slack) * 10**scale)
            fl_high = floor_div((q + slack) * 10**scale)
            if fl == fl_high:
                # Irrational here (exact results are generated separately), so `unnecessary` throws.
                return str(fl), encode(low[:-1] + [None], fl)
        dps *= 2
    raise RuntimeError(f'no convergence for {fn}{tuple(args)} at scale {scale}')


# ---------------------------------------------------------------------------
# Case generation
# ---------------------------------------------------------------------------

cases = []
DISTANCES = []


def distance_to_boundary(q: Fraction, scale: int) -> Fraction:
    """Distance from q to the nearest rounding boundary (any value with scale + 1 digits), in units of 10^-scale."""
    v = q * 10 ** (scale + 1)
    fl = floor_div(v)
    return min(v - fl, fl + 1 - v) / 10


def add(kind: str, fn: str, args, scale: int, n=None):
    if fn in ('sqrt', 'cbrt', 'nthRoot'):
        degree = 2 if fn == 'sqrt' else 3 if fn == 'cbrt' else n
        floor, offsets = root_reference(args[0], degree, scale)
        full_args = list(args) + ([n] if fn == 'nthRoot' else [])
    else:
        try:
            floor, offsets = transcendental_reference(fn, args, scale)
        except RuntimeError as error:  # an exact rational value sits on a boundary; not this generator's job
            print(f'skipped: {error}', file=sys.stderr)
            return
        full_args = list(args)
    cases.append({'kind': kind, 'fn': fn, 'args': full_args, 'scale': scale, 'floor': floor, 'offsets': offsets})


def random_scale() -> int:
    return rng.randint(1, 100)


# Random inputs, random scales 1-100.
for _ in range(120):
    add('random', 'sqrt', [random_decimal(-30, 30)], random_scale())
for _ in range(80):
    add('random', 'cbrt', [random_decimal(-30, 30, signed=True)], random_scale())
for _ in range(80):
    n = rng.randint(4, 12)
    add('random', 'nthRoot', [random_decimal(-20, 20, signed=n % 2 == 1)], rng.randint(1, 60), n)
for _ in range(120):
    add('random', 'exp', [random_decimal(-6, 2, signed=True, max_digits=30)], random_scale())
for _ in range(120):
    add('random', 'ln', [random_decimal(-30, 30)], random_scale())
for _ in range(80):
    add('random', 'log10', [random_decimal(-30, 30)], random_scale())
for _ in range(80):
    add('random', 'log2', [random_decimal(-30, 30)], random_scale())
for _ in range(60):
    base = random_decimal(-2, 3, max_digits=6)
    if to_fraction(base) == 1:
        continue
    add('random', 'log', [random_decimal(-20, 20), base], random_scale())
for _ in range(120):
    base = random_decimal(-2, 3, max_digits=12)
    exponent = random_decimal(-4, 2, signed=True, max_digits=20)
    if to_fraction(exponent).denominator == 1 or to_fraction(base) == 1:
        continue
    add('random', 'pow', [base, exponent], random_scale())


def boundary(scale: int, low: float, high: float, tie: bool) -> Fraction:
    """A random rounding boundary in [low, high): a value with `scale` digits, or a half-way point with scale + 1."""
    units = rng.randint(int(low * 10**scale), int(high * 10**scale) - 1)
    value = Fraction(units, 10**scale)
    return value + Fraction(5, 10 ** (scale + 1)) if tie else value


# Near-tie cases: the true value lies 10^-(scale + k) x |B| or so away from a boundary B,
# on either side, for k = 15, 25, 45, 90 (the library's first attempt carries 10 guard digits,
# then 20, 40, 80, 160).
for fn in ('exp', 'ln', 'log10', 'log2', 'pow'):
    for k in (15, 25, 45, 90):
        for tie in (True, False):
            for _ in range(4):
                scale = rng.randint(1, 100)
                with mp.workdps(scale + k + 60):
                    if fn == 'exp':
                        b = boundary(scale, 0.5, 50, tie)
                        x = mp.log(mp.mpf(b.numerator) / b.denominator)
                        args = [fraction_to_decimal(mpf_to_fraction(x), scale + k)]
                    elif fn == 'ln':
                        b = boundary(scale, -5, 5, tie) if rng.random() < 0.5 else boundary(scale, 0.1, 5, tie)
                        x = mp.exp(mp.mpf(b.numerator) / b.denominator)
                        args = [fraction_to_decimal(mpf_to_fraction(x), scale + k + 3)]
                    elif fn == 'log10':
                        b = boundary(scale, -3, 3, tie)
                        x = mp.power(10, mp.mpf(b.numerator) / b.denominator)
                        args = [fraction_to_decimal(mpf_to_fraction(x), scale + k + 4)]
                    elif fn == 'log2':
                        b = boundary(scale, -8, 8, tie)
                        x = mp.power(2, mp.mpf(b.numerator) / b.denominator)
                        args = [fraction_to_decimal(mpf_to_fraction(x), scale + k + 4)]
                    else:
                        base = rng.choice(['2.5', '3', '7', '0.3', '12.75'])
                        b = boundary(scale, 0.5, 40, tie)
                        y = mp.log(mp.mpf(b.numerator) / b.denominator) / mp.log(mp.mpf(base))
                        args = [base, fraction_to_decimal(mpf_to_fraction(y), scale + k)]
                        if to_fraction(args[1]).denominator == 1:
                            continue
                if b in (0, 1) or (fn in ('log10', 'log2') and b.denominator == 1):
                    continue  # the value would be exact
                add(f'near-tie k={k}', fn, args, scale)

# Roots: exact results on, just above and just below a boundary, and irrational ones within a hair.
for fn, n in (('sqrt', 2), ('cbrt', 3), ('nthRoot', 5)):
    for tie in (True, False):
        for k in (None, 1, 20):
            for _ in range(2):
                scale = rng.randint(1, 50)
                b = boundary(scale, 0.01, 30, tie)
                sign = -1 if (n % 2 == 1 and rng.random() < 0.5) else 1
                if k is None:
                    y = b
                else:
                    y = b + rng.choice((-1, 1)) * Fraction(1, 10 ** (scale + 1 + k))
                y *= sign
                digits = scale + 1 + (k or 0) + 1
                x = y**n  # exact: its root is exactly y
                coefficient = x * 10 ** (digits * n)
                assert coefficient.denominator == 1
                add(f'exact {"tie" if tie else "boundary"} k={k}', fn, [fmt(coefficient.numerator, digits * n)], scale, n if fn == 'nthRoot' else None)
                # Irrational, within 10^-(2 x scale) of the boundary: x = b^n + tiny.
                xi = b**n * sign ** n + sign * Fraction(1, 10 ** (n * (scale + 1) + 25))
                coefficient = xi * 10 ** (n * (scale + 1) + 25)
                assert coefficient.denominator == 1
                add(f'near-tie {"tie" if tie else "boundary"}', fn, [fmt(coefficient.numerator, n * (scale + 1) + 25)], scale, n if fn == 'nthRoot' else None)

# Exact transcendental-looking results (the library must detect them: `unnecessary` succeeds when exact at scale).
EXACT = [
    ('log', ['8', '2'], Fraction(3)),
    ('log', ['8', '4'], Fraction(3, 2)),
    ('log', ['0.001', '10'], Fraction(-3)),
    ('log', ['32', '0.25'], Fraction(-5, 2)),
    ('log10', ['1000'], Fraction(3)),
    ('log10', ['0.00001'], Fraction(-5)),
    ('log2', ['0.125'], Fraction(-3)),
    ('log2', ['1024'], Fraction(10)),
    ('pow', ['4', '0.5'], Fraction(2)),
    ('pow', ['0.25', '1.5'], Fraction(1, 8)),
    ('pow', ['16', '-0.25'], Fraction(1, 2)),
    ('pow', ['2.25', '0.5'], Fraction(3, 2)),
    ('pow', ['1.21', '2.5'], Fraction(161051, 100000)),
]
for fn, args, value in EXACT:
    for scale in (0, 1, 2, 3, 6, 20):
        floor, offsets = expected_from_rational(value, scale)
        cases.append({'kind': 'exact', 'fn': fn, 'args': args, 'scale': scale, 'floor': floor, 'offsets': offsets})

near = [d for (fn, d), c in zip(DISTANCES, [c for c in cases if c['fn'] not in ('sqrt', 'cbrt', 'nthRoot')]) if c['kind'].startswith('near-tie')]
print(f'near-tie transcendental cases: {len(near)}, max distance to a boundary {float(max(near)):.1e} units', file=sys.stderr)
out = Path(__file__).parent / 'fixtures' / 'decimal-math.json'
payload = {
    'generator': 'test/reference/gen_decimal_math.py',
    'reference': f'mpmath {mp.__version__} (Ziv loop, adaptive precision) and exact integer roots',
    'seed': SEED,
    'modes': MODES,
    'cases': cases,
}
out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
print(f'{len(cases)} cases -> {out} ({out.stat().st_size} bytes)', file=sys.stderr)
