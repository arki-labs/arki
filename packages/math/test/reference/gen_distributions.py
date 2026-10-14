#!/usr/bin/env python3
"""Reference values for @arki/math/distributions (special functions and distributions).

Writes fixtures/distributions.json. Every expected value is computed by mpmath
at 50 significant digits (more where a tail needs it) at the exact double
input, then rounded once to the nearest double. scipy is used only as a sanity
cross-check of the noncentral t integral (it wraps Boost); it never supplies a
fixture value.

Conventions follow scipy.stats: normal(mean, sd), studentT(df), chiSquare(df),
fisherF(dfn, dfd), noncentralT(df, nc), exponential(rate) = scipy expon(scale=1/rate),
binomial(n, p), poisson(mu). regularizedGammaP(a, x) is scipy gammainc(a, x);
regularizedBeta(x, a, b) is scipy betainc(a, b, x) (argument order differs).

Tails go as far as the double range allows (values down to ~1e-300), and
quantiles are taken at p down to 1e-300 (and 1 - p down to 1e-15).
"""

import json
import math
import random
import sys
from pathlib import Path

import mpmath as mp
import scipy
from scipy import stats as st

SEED = 20261014
rng = random.Random(SEED)
DPS = 50
mp.mp.dps = DPS
MIN_VALUE = 1e-300  # keep references in the normal double range

entries = []


def f64(v) -> float:
    """Round an mpf once to the nearest double."""
    return float(mp.mpf(v))


def add(name: str, params, method: str, points):
    kept = [p for p in points if p is not None]
    entries.append({'name': name, 'params': params, 'method': method, 'points': kept})


def safe(fn, *args):
    """fn(*args) as a double, or None when it leaves the normal double range."""
    with mp.workdps(DPS):
        v = fn(*args)
    if not mp.isfinite(v):
        return None
    x = f64(v)
    if x != 0 and (abs(x) < MIN_VALUE or not math.isfinite(x)):
        return None
    return x


def logspace(lo: float, hi: float, n: int):
    return [10 ** (lo + (hi - lo) * i / (n - 1)) for i in range(n)]


def linspace(lo: float, hi: float, n: int):
    return [lo + (hi - lo) * i / (n - 1) for i in range(n)]


def point(fn, *args):
    v = safe(fn, *[mp.mpf(a) for a in args])
    return None if v is None else [*args, v]


# ---------------------------------------------------------------------------
# Special functions
# ---------------------------------------------------------------------------

xs = linspace(-6, 6, 121) + [s * x for x in logspace(-300, -1, 30) for s in (1, -1)]
add('erf', [], 'value', [point(mp.erf, x) for x in xs if x != 0])
add('erfc', [], 'value', [point(mp.erfc, x) for x in linspace(-6, 26.5, 131) + logspace(-300, -1, 20)])

ps = linspace(-0.99, 0.99, 100) + [s * p for p in logspace(-300, -1, 30) for s in (1, -1)]
ps += [s * (1 - 10.0**-k) for k in range(2, 16) for s in (1, -1)]
add('erfInv', [], 'value', [point(mp.erfinv, p) for p in ps if p != 0])

gamma_x = logspace(-300, 2.2346, 80) + linspace(0.1, 10, 50) + [-x - 0.5 + rng.random() * 0.9 for x in range(0, 170, 7)]
gamma_x = [x for x in gamma_x if x < 171.6 and abs(x - round(x)) > 1e-9]
add('gamma', [], 'value', [point(mp.gamma, x) for x in gamma_x])
add('gammaLn', [], 'value', [point(mp.loggamma, x) for x in logspace(-300, 300, 120) + linspace(0.05, 5, 60)])

ab = logspace(-3, 3, 13)
add('beta', [], 'value', [point(mp.beta, a, b) for a in ab for b in ab])
add('betaLn', [], 'value', [point(lambda a, b: mp.log(mp.beta(a, b)), a, b) for a in ab for b in ab])

gamma_p = []
for a in logspace(-2, 3, 16):
    for ratio in logspace(-3, 1, 15) + [0.9, 1.1]:
        x = a * ratio
        gamma_p.append(point(lambda a_, x_: mp.gammainc(a_, 0, x_, regularized=True), a, x))
add('regularizedGammaP', [], 'value', gamma_p)

beta_i = []
for a in logspace(-1, 3, 9):
    for b in logspace(-1, 3, 9):
        for x in [0.001, 0.01, 0.1, 0.3, 0.5, 0.7, 0.9, 0.99, 0.999, a / (a + b)]:
            beta_i.append(point(lambda x_, a_, b_: mp.betainc(a_, b_, 0, x_, regularized=True), x, a, b))
add('regularizedBeta', [], 'value', beta_i)

# ---------------------------------------------------------------------------
# Distributions
# ---------------------------------------------------------------------------


def continuous(name, params, cdf, sf, pdf, xs_, quantile_ps, quantile_ref):
    add(name, params, 'cdf', [point(cdf, x) for x in xs_])
    add(name, params, 'sf', [point(sf, x) for x in xs_])
    add(name, params, 'pdf', [point(pdf, x) for x in xs_])
    add(name, params, 'quantile', [point(quantile_ref, p) for p in quantile_ps])


def find_quantile(cdf, sf, p, guess, positive=False):
    """x with cdf(x) = p, solved on the side (cdf or sf) that keeps p accurate.

    The equation is taken in logs, log cdf(x) = log p (or log sf(x) = log(1 - p)),
    bracketed around scipy's guess and solved with the Illinois method; positive
    supports are solved in u = log x so tails near 0 stay well scaled.
    """
    with mp.workdps(DPS + 20):
        p = mp.mpf(p)
        if p < 0.5:
            g = lambda x: mp.log(cdf(x)) - mp.log(p)  # noqa: E731
        else:
            q = 1 - p
            g = lambda x: mp.log(q) - mp.log(sf(x))  # noqa: E731
        to_x = (lambda u: mp.exp(u)) if positive else (lambda u: u)  # noqa: E731
        h = lambda u: g(to_x(u))  # noqa: E731
        guess = mp.mpf(guess) if math.isfinite(guess) and (guess > 0 or not positive) else mp.mpf(1)
        u0 = mp.log(guess) if positive else guess
        width = mp.mpf(1) if positive else max(abs(u0) * mp.mpf('0.01'), mp.mpf('0.01'))
        lo, hi = u0 - width, u0 + width
        for _ in range(200):
            if h(lo) < 0:
                break
            lo -= width
            width *= 2
        for _ in range(200):
            if h(hi) > 0:
                break
            hi += width
            width *= 2
        u = mp.findroot(h, (lo, hi), solver='illinois', tol=mp.mpf(10) ** (-2 * DPS), maxsteps=500)
        return to_x(u)


QUANTILE_PS = logspace(-300, -1, 20) + linspace(0.05, 0.95, 19) + [1 - 10.0**-k for k in range(2, 16)]


def norm_cdf(x):
    return mp.erfc(-x / mp.sqrt(2)) / 2


def norm_sf(x):
    return mp.erfc(x / mp.sqrt(2)) / 2


def norm_pdf(x):
    return mp.npdf(x)


def norm_quantile(p):
    with mp.workdps(400):
        return -mp.sqrt(2) * mp.erfinv(1 - 2 * mp.mpf(p)) if p < 0.5 else mp.sqrt(2) * mp.erfinv(2 * mp.mpf(p) - 1)


continuous('normal', [0, 1], norm_cdf, norm_sf, norm_pdf, linspace(-37, 37, 149), QUANTILE_PS, norm_quantile)
continuous(
    'normal',
    [100, 15],
    lambda x: norm_cdf((x - 100) / 15),
    lambda x: norm_sf((x - 100) / 15),
    lambda x: norm_pdf((x - 100) / 15) / 15,
    linspace(-400, 600, 41),
    linspace(0.01, 0.99, 15),
    lambda p: 100 + 15 * norm_quantile(p),
)


def t_cdf(df):
    def cdf(x):
        if x == 0:
            return mp.mpf(1) / 2
        tail = mp.betainc(df / 2, mp.mpf(1) / 2, 0, df / (df + x * x), regularized=True) / 2
        return tail if x < 0 else 1 - tail

    return cdf


def t_pdf(df):
    return lambda x: mp.gamma((df + 1) / 2) / (mp.sqrt(df * mp.pi) * mp.gamma(df / 2)) * (1 + x * x / df) ** (-(df + 1) / 2)


for df in (1, 2, 3, 5, 10, 30, 100, 1000):
    cdf = t_cdf(mp.mpf(df))
    sf = lambda x, cdf=cdf: cdf(-x)  # noqa: E731 (symmetric)
    xs_ = linspace(-10, 10, 41) + [s * x for x in logspace(1.5, 8, 12) for s in (1, -1)]
    ps_ = logspace(-40 if df >= 5 else -100, -1, 12) + linspace(0.05, 0.95, 10) + [1 - 10.0**-k for k in (2, 4, 6, 8, 10, 12)]
    continuous('studentT', [df], cdf, sf, t_pdf(mp.mpf(df)), xs_, ps_, lambda p, cdf=cdf, sf=sf, df=df: find_quantile(cdf, sf, p, st.t.ppf(float(p), df)))


def chi2_cdf(k):
    return lambda x: mp.gammainc(k / 2, 0, x / 2, regularized=True) if x > 0 else mp.mpf(0)


def chi2_sf(k):
    return lambda x: mp.gammainc(k / 2, x / 2, mp.inf, regularized=True) if x > 0 else mp.mpf(1)


def chi2_pdf(k):
    return lambda x: x ** (k / 2 - 1) * mp.exp(-x / 2) / (2 ** (k / 2) * mp.gamma(k / 2)) if x > 0 else mp.mpf(0)


for k in (1, 2, 3, 5, 10, 50, 200, 1000):
    km = mp.mpf(k)
    xs_ = [x * k for x in logspace(-4, 1, 30)] + [k + 40 * math.sqrt(2 * k) + 10 * i * k for i in range(5)]
    ps_ = logspace(-100, -1, 12) + linspace(0.05, 0.95, 10) + [1 - 10.0**-e for e in (2, 4, 6, 8, 10, 12)]
    cdf, sf = chi2_cdf(km), chi2_sf(km)
    continuous('chiSquare', [k], cdf, sf, chi2_pdf(km), xs_, ps_, lambda p, cdf=cdf, sf=sf, k=k: find_quantile(cdf, sf, p, st.chi2.ppf(float(p), k), positive=True))


def f_cdf(d1, d2):
    return lambda x: mp.betainc(d1 / 2, d2 / 2, 0, d1 * x / (d1 * x + d2), regularized=True) if x > 0 else mp.mpf(0)


def f_sf(d1, d2):
    return lambda x: mp.betainc(d2 / 2, d1 / 2, 0, d2 / (d1 * x + d2), regularized=True) if x > 0 else mp.mpf(1)


def f_pdf(d1, d2):
    return (
        lambda x: mp.sqrt((d1 * x) ** d1 * d2**d2 / (d1 * x + d2) ** (d1 + d2)) / (x * mp.beta(d1 / 2, d2 / 2))
        if x > 0
        else mp.mpf(0)
    )


for d1, d2 in ((1, 1), (2, 5), (3, 10), (10, 3), (5, 50), (50, 5), (100, 100)):
    a, b = mp.mpf(d1), mp.mpf(d2)
    xs_ = logspace(-4, 4, 33)
    ps_ = logspace(-60, -1, 10) + linspace(0.05, 0.95, 10) + [1 - 10.0**-e for e in (2, 4, 6, 8, 10)]
    cdf, sf = f_cdf(a, b), f_sf(a, b)
    continuous('fisherF', [d1, d2], cdf, sf, f_pdf(a, b), xs_, ps_, lambda p, cdf=cdf, sf=sf, d1=d1, d2=d2: find_quantile(cdf, sf, p, st.f.ppf(float(p), d1, d2), positive=True))


def nct_cdf(df, nc):
    """P(T <= t) = integral over v of Phi(t sqrt(v/df) - nc) times the chi-square(df) density."""
    density = chi2_pdf(df)

    def cdf(t):
        with mp.workdps(30):
            return mp.quad(lambda v: mp.ncdf(t * mp.sqrt(v / df) - nc) * density(v), [0, df / 2, df, 2 * df, 4 * df, mp.inf])

    return cdf


nct_checks = []
for df, nc in ((5, 1), (10, 1), (10, -2), (30, 3), (20, 0.5), (50, 10)):
    cdf = nct_cdf(mp.mpf(df), mp.mpf(nc))
    xs_ = linspace(nc - 6, nc + 8, 29)
    pts = [point(cdf, x) for x in xs_]
    add('noncentralT', [df, nc], 'cdf', pts)
    for x, want in [p for p in pts if p]:
        nct_checks.append(abs(st.nct.cdf(x, df, nc) - want) / max(want, 1e-300))

for rate in (0.5, 2):
    r = mp.mpf(rate)
    continuous(
        'exponential',
        [rate],
        lambda x, r=r: -mp.expm1(-r * x) if x > 0 else mp.mpf(0),
        lambda x, r=r: mp.exp(-r * x) if x > 0 else mp.mpf(1),
        lambda x, r=r: r * mp.exp(-r * x) if x >= 0 else mp.mpf(0),
        logspace(-10, 2.5, 30),
        logspace(-300, -1, 12) + [1 - 10.0**-e for e in (2, 6, 10, 14)],
        lambda p, r=r: -mp.log1p(-mp.mpf(p)) / r,
    )


# ---------------------------------------------------------------------------
# Discrete distributions: pmf, cdf and sf at every k; quantile at random p
# ---------------------------------------------------------------------------


def discrete(name, params, pmf, support, beyond=()):
    """pmf, cdf and sf on `support`; `beyond` lists the rest of an infinite support that sf must still sum."""
    with mp.workdps(DPS):
        masses = [pmf(k) for k in support]
        cdfs, total = [], mp.mpf(0)
        for m in masses:
            total += m
            cdfs.append(total)
        sfs, total = [], mp.fsum(pmf(k) for k in beyond)
        for m in reversed(masses):
            sfs.append(total)
            total += m
        sfs.reverse()
    keep = lambda v: v == 0 or abs(f64(v)) >= MIN_VALUE  # noqa: E731
    # Every k for small supports; about 150 evenly spaced k (tails included) for large ones.
    stride = max(1, len(support) // 150)
    sampled = [i for i in range(len(support)) if i % stride == 0 or i == len(support) - 1]
    add(name, params, 'pmf', [[support[i], f64(masses[i])] for i in sampled if keep(masses[i])])
    add(name, params, 'cdf', [[support[i], f64(cdfs[i])] for i in sampled if keep(cdfs[i])])
    add(name, params, 'sf', [[support[i], f64(sfs[i])] for i in sampled if keep(sfs[i])])
    quantiles = []
    for _ in range(40):
        p = rng.random()
        # Skip p within 1e-12 of a cdf step, where the double cdf may legitimately sit on either side.
        if any(abs(c - p) < 1e-12 for c in cdfs):
            continue
        k = next(k for k, c in zip(support, cdfs) if c >= p)
        quantiles.append([p, k])
    add(name, params, 'quantile', quantiles)


def binomial_pmf(n, p):
    pm = mp.mpf(p)
    return lambda k: mp.binomial(n, k) * pm**k * (1 - pm) ** (n - k)


for n, p in ((10, 0.5), (20, 0.05), (100, 0.3), (1000, 0.01), (1000, 0.9)):
    discrete('binomial', [n, p], binomial_pmf(n, p), list(range(n + 1)))


def poisson_pmf(lam):
    lm = mp.mpf(lam)
    return lambda k: mp.exp(-lm) * lm**k / mp.factorial(k)


for lam in (0.5, 3, 50, 1000):
    upper = int(lam + 40 * math.sqrt(lam) + 40)
    # sf sums the masses past `upper` too, far enough (to 3 x upper) that the rest is below 1e-50 of it.
    discrete('poisson', [lam], poisson_pmf(lam), list(range(upper + 1)), range(upper + 1, 3 * upper + 100))

out = Path(__file__).parent / 'fixtures' / 'distributions.json'
payload = {
    'generator': 'test/reference/gen_distributions.py',
    'reference': f'mpmath {mp.__version__} at {DPS} digits; scipy {scipy.__version__} only cross-checks the noncentral t',
    'entries': entries,
}
out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
count = sum(len(e['points']) for e in entries)
print(f'{len(entries)} entries, {count} points -> {out} ({out.stat().st_size} bytes)', file=sys.stderr)
print(f'noncentral t: mpmath integral vs scipy (Boost) max relative difference {max(nct_checks):.1e}', file=sys.stderr)
