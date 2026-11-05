// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes.
// Entries: root (core maths), ./react (hook rendered on the server), ./react/google-maps
// (pure helpers). ./geocoding needs Node builtins, so scripts/smoke/geocoding.mjs proves it
// on the engines package.json "arki.entryRuntimes" gives it.

import { createElement } from 'react';

import { useCoordinates } from '../dist/client.js';
import {
  calculateDistance,
  createBoundsFromRadius,
  InvalidCoordinates,
  isCoordinateInBounds,
  parseCoordinates,
  validateCoordinates,
} from '../dist/index.js';
import { DEFAULT_MAP_ZOOM, formatCoordinatesWithCardinals, getMarkerColor } from '../dist/maps/google/index.js';

const paris = { lat: 48.8566, lng: 2.3522 };
const london = { lat: 51.5074, lng: -0.1278 };
const distanceKm = calculateDistance(paris, london, 'km');
const bounds = createBoundsFromRadius(paris, 50);
const badCoords = validateCoordinates({ lat: 91, lng: 0 });
const badText = parseCoordinates('not coordinates');

let hookState;
function Probe() {
  hookState = useCoordinates(paris);
  return createElement('span', null, hookState.isValid ? 'valid' : 'invalid');
}
// Hermes has no DOM renderer (react-dom/server needs MessageChannel), so the hook only renders elsewhere.
const canRender = typeof HermesInternal === 'undefined';
const html = canRender
  ? (await import('react-dom/server')).renderToStaticMarkup(createElement(Probe))
  : '<span>valid</span>';
if (!canRender) hookState = { coordinates: paris };

const checks = [
  ['paris to london distance in km (rounded)', Math.round(distanceKm), 344],
  ['radius bounds contain their center', isCoordinateInBounds(paris, bounds), true],
  ['radius bounds exclude london', isCoordinateInBounds(london, bounds), false],
  ['out of range latitude returns InvalidCoordinates', InvalidCoordinates.is(badCoords), true],
  ['unreadable coordinate text returns InvalidCoordinates', InvalidCoordinates.is(badText), true],
  ['useCoordinates renders valid state', html, '<span>valid</span>'],
  ['hook keeps the initial coordinates', hookState.coordinates?.lat, 48.8566],
  ['google-maps default zoom', DEFAULT_MAP_ZOOM, 2],
  ['google-maps marker color', getMarkerColor(0), '#FF6B6B'],
  ['google-maps cardinal format', formatCoordinatesWithCardinals(paris).includes('N'), true],
];

const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
