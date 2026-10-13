// Runs the browser-bundled smoke test (built by `bun build scripts/smoke.mjs
// --target=browser`) inside headless Chromium when Playwright is installed in
// the workspace; otherwise reports the bundle size and skips, loudly.

import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const bundlePath = new URL('../.cache/browser-check/smoke.js', import.meta.url);
const size = statSync(bundlePath).size;
console.log(`browser bundle (smoke + library, unminified): ${size} bytes`);

let chromium;
try {
  ({ chromium } = createRequire(import.meta.url)('playwright'));
} catch {
  console.log('browser: playwright not installed, Chromium run skipped (bundle built for browser target OK)');
  process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', message => logs.push(message.text()));
page.on('pageerror', error => logs.push(`pageerror: ${error.message}`));
await page.setContent('<!doctype html><title>smoke</title>');
await page.addScriptTag({ type: 'module', content: readFileSync(bundlePath, 'utf8') });
await page.waitForTimeout(1000);
await browser.close();

const summary = logs.find(line => line.includes('smoke checks passed'));
for (const line of logs) console.log(line);
if (!summary || logs.some(line => line.startsWith('FAIL') || line.startsWith('pageerror'))) {
  console.error('browser smoke FAILED');
  process.exit(1);
}
