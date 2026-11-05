/**
 * The app proof of the Hermes leg. A React Native component needs Fabric and the
 * native modules of its libraries (react-native-svg, reanimated and worklets,
 * react-native-screens), which the bare Hermes runner does not have. So a package
 * with `"arki": { "hermesApp": "app" }` keeps a small Expo app in that folder that
 * renders its components, and with `ARKI_RN_APP=1` the Hermes leg:
 *
 *   1. packs the package (`bun pm pack`) into `<app>/.cache/<name>.tgz`, the file the
 *      app depends on, so the app installs the package as npm would ship it;
 *   2. `bun install`s the app (its own lockfile, outside the workspace);
 *   3. runs `expo prebuild` and `pod install` when `<app>/ios` is missing;
 *   4. builds the Release configuration for the iOS simulator (Hermes bytecode);
 *   5. installs it fresh on a simulator (`ARKI_RN_SIMULATOR`, or the first iPhone on
 *      the newest iOS), launches it, and reads `Documents/arki-app-smoke.txt` from the
 *      app's data folder. The app writes `N smoke checks passed (...)` there when every
 *      component laid out, or `FAIL ...` lines.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Runs a command; throws when it cannot start. The caller owns the error types. */
export type Exec = (
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) => { output: string; status: number | null };

export const APP_RESULT_FILE = 'arki-app-smoke.txt';
const SUMMARY = /smoke checks passed/;
const LAID_OUT = /^\d+\/\d+ checks laid out/;
const RESULT_DEADLINE_MS = 120_000;
const MINUTE = 60_000;

const appJsonSchema = z.object({
  expo: z.object({
    name: z.string().min(1),
    ios: z.object({ bundleIdentifier: z.string().min(1) }),
  }),
});

const appPackageSchema = z.object({ dependencies: z.record(z.string(), z.string()) });

/** The tarball name a package packs to: `@arki/native-ui` is `arki-native-ui.tgz`. */
export function tarballName(packageName: string): string {
  return `${packageName.replace(/^@/, '').replace('/', '-')}.tgz`;
}

/** The Xcode scheme `expo prebuild` makes from the app name: letters and digits only. */
export function schemeName(appName: string): string {
  return appName.replaceAll(/[^a-z0-9]/gi, '');
}

/** What the harness needs from the app folder, checked: its scheme, bundle id and package tarball. */
export function readApp(
  appDir: string,
  packageName: string,
): { scheme: string; bundleId: string; tarball: string } {
  const appJson = appJsonSchema.parse(JSON.parse(readFileSync(path.join(appDir, 'app.json'), 'utf8')));
  const appPackage = appPackageSchema.parse(JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8')));
  const tarball = `.cache/${tarballName(packageName)}`;
  const wanted = `file:${tarball}`;
  if (appPackage.dependencies[packageName] !== wanted) {
    throw new Error(
      `${path.join(appDir, 'package.json')} must depend on "${packageName}": "${wanted}", the packed package`,
    );
  }
  return { scheme: schemeName(appJson.expo.name), bundleId: appJson.expo.ios.bundleIdentifier, tarball };
}

const simctlDevicesSchema = z.object({
  devices: z.record(
    z.string(),
    z.array(z.object({ udid: z.string(), name: z.string(), state: z.string(), isAvailable: z.boolean() })),
  ),
});

export type Simulator = { udid: string; name: string; runtime: string; booted: boolean };

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` is `[26, 5]`; any other platform is `undefined`. */
function iosVersion(runtime: string): number[] | undefined {
  const match = /SimRuntime\.iOS-([\d-]+)$/.exec(runtime);
  return match?.[1]?.split('-').map(Number);
}

function newerFirst(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (b[index] ?? 0) - (a[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Picks the simulator from `simctl list devices available --json`: the device named or
 * with the UDID in `wanted`, else a booted iPhone, else the first iPhone on the newest iOS.
 */
export function pickSimulator(listJson: string, wanted?: string): Simulator | undefined {
  const { devices } = simctlDevicesSchema.parse(JSON.parse(listJson));
  const all = Object.entries(devices)
    .map(([runtime, list]) => ({ runtime, version: iosVersion(runtime), list }))
    .filter((entry): entry is { runtime: string; version: number[]; list: typeof entry.list } => !!entry.version)
    .toSorted((a, b) => newerFirst(a.version, b.version))
    .flatMap(({ runtime, list }) =>
      list
        .filter(device => device.isAvailable)
        .map(device => ({ udid: device.udid, name: device.name, runtime, booted: device.state === 'Booted' })),
    );
  if (wanted) return all.find(device => device.udid === wanted || device.name === wanted);
  const iphones = all.filter(device => device.name.startsWith('iPhone'));
  return iphones.find(device => device.booted) ?? iphones[0];
}

/**
 * The app's result file. Its last line is the summary on a pass, or `N/M checks laid out`
 * after the `FAIL` lines; until one of those is there the app is still writing (`done: false`).
 */
export function appResult(text: string): { done: boolean; passed: boolean; summary: string | undefined } {
  const lines = text.split('\n').map(line => line.trim());
  const summary = lines.find(line => SUMMARY.test(line));
  const done = !!summary || lines.some(line => LAID_OUT.test(line));
  return { done, passed: !!summary && !lines.some(line => line.startsWith('FAIL')), summary };
}

function must(exec: Exec, command: string, args: readonly string[], cwd: string, timeoutMs: number): string {
  const { output, status } = exec(command, args, cwd, timeoutMs);
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${String(status)}\n${output.slice(-4000)}`);
  return output;
}

/** Builds the package's app, runs it in an iOS simulator and returns the app's summary line. */
export async function runHermesApp(
  exec: Exec,
  packageDir: string,
  packageName: string,
  appFolder: string,
): Promise<string> {
  const appDir = path.resolve(packageDir, appFolder);
  const { scheme, bundleId, tarball } = readApp(appDir, packageName);

  must(exec, 'bun', ['pm', 'pack', '--quiet', '--filename', path.join(appDir, tarball)], packageDir, 5 * MINUTE);
  // A fresh copy of the package: bun keeps an installed tarball dependency otherwise.
  rmSync(path.join(appDir, 'node_modules', packageName), { recursive: true, force: true });
  must(exec, 'bun', ['install'], appDir, 10 * MINUTE);

  const iosDir = path.join(appDir, 'ios');
  if (!existsSync(iosDir)) {
    must(exec, 'node', ['node_modules/expo/bin/cli', 'prebuild', '--platform', 'ios', '--no-install'], appDir, 5 * MINUTE);
    must(exec, 'pod', ['install'], iosDir, 20 * MINUTE);
  }
  const derived = path.join(iosDir, 'build', 'derived');
  must(
    exec,
    'xcodebuild',
    [
      '-workspace',
      `${scheme}.xcworkspace`,
      '-scheme',
      scheme,
      '-configuration',
      'Release',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derived,
      '-quiet',
      'build',
    ],
    iosDir,
    40 * MINUTE,
  );
  const appBundle = path.join(derived, 'Build', 'Products', 'Release-iphonesimulator', `${scheme}.app`);

  const list = must(exec, 'xcrun', ['simctl', 'list', 'devices', 'available', '--json'], appDir, MINUTE);
  const simulator = pickSimulator(list, process.env['ARKI_RN_SIMULATOR']);
  if (!simulator) throw new Error('no available iPhone simulator; install an iOS runtime or set ARKI_RN_SIMULATOR');
  if (!simulator.booted) must(exec, 'xcrun', ['simctl', 'boot', simulator.udid], appDir, 5 * MINUTE);
  try {
    must(exec, 'xcrun', ['simctl', 'bootstatus', simulator.udid, '-b'], appDir, 5 * MINUTE);
    // Uninstall first, so the data folder holds no result from an earlier run.
    exec('xcrun', ['simctl', 'uninstall', simulator.udid, bundleId], appDir, MINUTE);
    must(exec, 'xcrun', ['simctl', 'install', simulator.udid, appBundle], appDir, 5 * MINUTE);
    must(exec, 'xcrun', ['simctl', 'launch', simulator.udid, bundleId], appDir, MINUTE);
    const container = must(exec, 'xcrun', ['simctl', 'get_app_container', simulator.udid, bundleId, 'data'], appDir, MINUTE).trim();
    const resultFile = path.join(container, 'Documents', APP_RESULT_FILE);
    const deadline = Date.now() + RESULT_DEADLINE_MS;
    let text = '';
    while (!appResult(text).done && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      text = existsSync(resultFile) ? readFileSync(resultFile, 'utf8') : '';
    }
    const { done, passed, summary } = appResult(text);
    if (!done) {
      throw new Error(
        `the app wrote no result to ${APP_RESULT_FILE} within ${String(RESULT_DEADLINE_MS / 1000)} s (it may have crashed on launch)`,
      );
    }
    if (!passed || !summary) throw new Error(`the app on ${simulator.name} did not pass\n${text}`);
    return `${summary} on ${simulator.name}`;
  } finally {
    exec('xcrun', ['simctl', 'terminate', simulator.udid, bundleId], appDir, MINUTE);
    if (!simulator.booted) exec('xcrun', ['simctl', 'shutdown', simulator.udid], appDir, MINUTE);
  }
}
