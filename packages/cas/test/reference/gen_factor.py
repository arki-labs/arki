#!/usr/bin/env python3
"""Reference factorizations over Q for @arki/cas `factor` (RFC 2026-10-15-arki-cas §13).

Writes fixtures/factor.json: for each polynomial, SymPy's factor_list over Q
(the content and every irreducible factor with its multiplicity). Dev-only
and offline; the package never depends on SymPy. Run:

    uv run --with-requirements requirements.txt python gen_factor.py

The set: cyclotomic polynomials, Swinnerton-Dyer polynomials (every prime
splits them into many factors: recombination stress), Mignotte-style factors
whose coefficients are larger than the product's, and seeded random products
of up to degree 40 with up to 30-digit coefficients.
"""
import json
import random
from pathlib import Path

from sympy import Poly, QQ, Symbol, cyclotomic_poly, swinnerton_dyer_poly

x = Symbol("x")


def coefficients(p):
    """Ascending coefficient strings of a Poly."""
    return [str(c) for c in reversed(Poly(p, x).all_coeffs())]


def case(name, p):
    poly = Poly(p, x, domain=QQ)
    content, factors = poly.factor_list()
    parts = []
    for f, m in factors:
        # SymPy's factors are primitive over Z up to sign; make the leading coefficient positive.
        f = f.clear_denoms()[1]
        if f.LC() < 0:
            f = -f
            content = content * (-1) ** m
        parts.append({"coefficients": coefficients(f.as_expr()), "multiplicity": m})
    parts.sort(key=lambda part: (len(part["coefficients"]), part["coefficients"]))
    return {"name": name, "input": coefficients(poly.as_expr()), "content": str(content), "factors": parts}


def main():
    rng = random.Random(20261015)
    cases = []
    for n in (12, 30, 60):
        cases.append(case(f"x^{n} - 1", x**n - 1))
    for n in (16, 24):
        cases.append(case(f"x^{n} + 1", x**n + 1))
    for n in (5, 7, 9, 15):
        cases.append(case(f"cyclotomic {n}", cyclotomic_poly(n, x)))
    for n in (1, 2, 3, 4):
        cases.append(case(f"Swinnerton-Dyer S_{n}", swinnerton_dyer_poly(n, x)))
    cases.append(case("S_3 * S_2", swinnerton_dyer_poly(3, x) * swinnerton_dyer_poly(2, x)))
    for n, a in ((7, 5), (10, 7), (12, 11)):
        mignotte = x**n - 2 * (a * x - 1) ** 2
        cases.append(case(f"Mignotte x^{n} - 2({a}x - 1)^2 times x^3 + 17x - 1", mignotte * (x**3 + 17 * x - 1)))
    cases.append(case("x^4 + 1 (irreducible, splits mod every prime)", x**4 + 1))
    cases.append(case("x^8 + 98x^4 + 1", x**8 + 98 * x**4 + 1))
    cases.append(case("rational content", (x**2 - 2) * (3 * x + 1) / 12))
    cases.append(case("repeated factors", (x - 1) ** 3 * (x**2 + x + 1) ** 2 * (2 * x - 3)))
    for i in range(24):
        degree_total = rng.choice([6, 10, 16, 24, 40]) if i < 20 else 40
        digits = rng.choice([1, 2, 6]) if i < 20 else 30
        product = 1
        remaining = degree_total
        while remaining > 0:
            d = min(remaining, rng.randint(1, 8))
            bound = 10**digits
            coeffs = [rng.randint(-bound, bound) for _ in range(d)] + [rng.randint(1, bound)]
            product *= sum(c * x**k for k, c in enumerate(coeffs))
            remaining -= d
        cases.append(case(f"random product {i}", product))
    out = Path(__file__).with_name("fixtures") / "factor.json"
    out.write_text(json.dumps({"generator": "gen_factor.py", "sympy": "1.14.0", "cases": cases}, indent=1) + "\n")
    print(f"wrote {len(cases)} cases to {out}")


if __name__ == "__main__":
    main()
