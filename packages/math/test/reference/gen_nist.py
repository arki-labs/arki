#!/usr/bin/env python3
"""NIST Statistical Reference Datasets (StRD) as one JSON fixture.

Downloads the certified datasets from https://www.itl.nist.gov/div898/strd/
(univariate summary statistics and linear least squares) and writes
fixtures/nist-strd.json: for each dataset its source URL, level of
difficulty, certified values and data. Numbers stay decimal strings exactly
as NIST prints them, so the exact (Decimal) path sees the true inputs.

Usage: python3 gen_nist.py [directory with already downloaded .dat files]
"""

import json
import re
import sys
import urllib.request
from pathlib import Path

BASE = 'https://www.itl.nist.gov/div898/strd'
UNIVARIATE = ['PiDigits', 'Lottery', 'Lew', 'Mavro', 'Michelso', 'NumAcc1', 'NumAcc2', 'NumAcc3', 'NumAcc4']
LINEAR = ['Norris', 'Pontius', 'NoInt1', 'NoInt2', 'Filip', 'Longley', 'Wampler1', 'Wampler2', 'Wampler3', 'Wampler4', 'Wampler5']
NUMBER = r'[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?'


def url_of(name: str) -> str:
    return f'{BASE}/univ/data/{name}.dat' if name in UNIVARIATE else f'{BASE}/lls/data/LINKS/DATA/{name}.dat'


def fetch(name: str, local: Path | None) -> str:
    if local is not None:
        return (local / f'{name}.dat').read_text()
    # NIST refuses Python's default User-Agent (HTTP 403).
    request = urllib.request.Request(url_of(name), headers={'User-Agent': 'curl/8 (@arki/math reference fixtures)'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read().decode('ascii')


def data_rows(text: str, columns: int) -> list[list[str]]:
    """The numeric rows after the header (lines named by the 'Data' line range)."""
    lines = text.splitlines()
    match = re.search(r'Data\s*[:(]?\s*lines\s+(\d+)\s+to\s+(\d+)', text)
    if not match:
        raise ValueError('no data line range')
    first, last = int(match.group(1)), int(match.group(2))
    rows = []
    for line in lines[first - 1 : last]:
        values = re.findall(NUMBER, line)
        if len(values) == columns:
            rows.append(values)
    return rows


# Michelso's header omits its level; NIST's univariate index lists it as lower difficulty.
DIFFICULTY_NOT_IN_HEADER = {'Michelso': 'lower'}


def difficulty(name: str, text: str) -> str:
    match = re.search(r'(Lower|Average|Higher) Level of\s+Difficulty', text)
    if match:
        return match.group(1).lower()
    if name in DIFFICULTY_NOT_IN_HEADER:
        return DIFFICULTY_NOT_IN_HEADER[name]
    raise ValueError(f'{name}: no level of difficulty')


def univariate(name: str, text: str) -> dict:
    mean = re.search(rf'Sample Mean\s+ybar:\s+({NUMBER})', text)
    sd = re.search(rf'Sample Standard Deviation \(denom\. = n-1\)\s+s:\s+({NUMBER})', text)
    autocorrelation = re.search(rf'r\(1\):\s+({NUMBER})', text)
    n = re.search(r'Number of Observations:\s+(\d+)', text)
    if not (mean and sd and autocorrelation and n):
        raise ValueError(f'{name}: certified values not found')
    data = [row[0] for row in data_rows(text, 1)]
    if len(data) != int(n.group(1)):
        raise ValueError(f'{name}: expected {n.group(1)} observations, parsed {len(data)}')
    return {
        'name': name,
        'url': url_of(name),
        'kind': 'univariate',
        'difficulty': difficulty(name, text),
        'certified': {'mean': mean.group(1), 'stddev': sd.group(1), 'autocorrelation': autocorrelation.group(1)},
        'data': data,
    }


def linear(name: str, text: str) -> dict:
    parameters = re.findall(rf'^\s*B(\d+)\s+({NUMBER})\s+({NUMBER})', text, re.MULTILINE)
    residual = re.search(rf'Residual\s+Standard Deviation\s+({NUMBER})', text)
    r2 = re.search(rf'R-Squared\s+({NUMBER})', text)
    model = re.search(r'Model:\s+(.+?)\n\s*\n', text, re.DOTALL)
    predictors = re.search(r'(\d+)\s+Predictor Variables?', text)
    observations = re.search(r'(\d+)\s+Observations', text)
    if not (parameters and residual and r2 and model and predictors and observations):
        raise ValueError(f'{name}: certified values not found')
    columns = 1 + int(predictors.group(1))
    data = data_rows(text, columns)
    if len(data) != int(observations.group(1)):
        raise ValueError(f'{name}: expected {observations.group(1)} observations, parsed {len(data)}')
    return {
        'name': name,
        'url': url_of(name),
        'kind': 'linear',
        'difficulty': difficulty(name, text),
        'model': ' '.join(model.group(1).split()),
        'certified': {
            'parameters': [{'estimate': est, 'standardDeviation': sd} for _, est, sd in parameters],
            'residualStandardDeviation': residual.group(1),
            'rSquared': r2.group(1),
        },
        # Columns: y, then the predictors (x, or x1..xk for Longley).
        'data': data,
    }


def main() -> None:
    local = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    datasets = [univariate(n, fetch(n, local)) for n in UNIVARIATE] + [linear(n, fetch(n, local)) for n in LINEAR]
    out = Path(__file__).parent / 'fixtures' / 'nist-strd.json'
    payload = {
        'source': 'NIST/ITL Statistical Reference Datasets, https://www.itl.nist.gov/div898/strd/ (public domain)',
        'generator': 'test/reference/gen_nist.py',
        'datasets': datasets,
    }
    out.write_text(json.dumps(payload, separators=(',', ':')) + '\n')
    print(f'{len(datasets)} datasets -> {out} ({out.stat().st_size} bytes)', file=sys.stderr)


main()
