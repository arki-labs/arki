// Cross-runtime smoke test of ./collections, the one entry that runs on every engine, React Native
// included. It runs the BUILT entry under Node, Bun and Deno via `bun run test:runtimes`, and is
// bundled for the browser and Hermes. The other entries store to IndexedDB or listen to browser
// events, so package.json "arki.entryRuntimes" keeps them off Hermes and scripts/smoke/<entry>.mjs
// proves each on the engines it claims.
//
// On Hermes this file first sets the globals React Native sets (Libraries/Core/setUpGlobals.js and
// setUpNavigator.js in react-native 0.86): `window` and `self` are the global object, and `navigator`
// is `{ product: 'ReactNative' }`, with no `onLine` and no events. React Native has no `crypto`,
// no IndexedDB and no `localStorage`, and neither has the bare Hermes runner. The entry is imported
// only after that, so a guard that mistakes `window` for a browser fails here as it would in an app.

import { z } from "zod";

const isHermes = typeof HermesInternal !== "undefined";
if (isHermes) {
  globalThis.window = globalThis;
  globalThis.self = globalThis;
  globalThis.navigator = { product: "ReactNative" };
}

const { createLocalCollection, createMemoryCollection } =
  await import("../dist/src/collections/index.js");

const itemSchema = z.object({ id: z.string(), name: z.string() });
const memoryConfig = {
  schema: itemSchema,
  getKey: (item) => item.id,
  initialData: [{ id: "a", name: "Ada" }],
};

// TanStack DB names local-only collections and every write's transaction with crypto.randomUUID or
// crypto.getRandomValues. React Native has neither: an app installs `react-native-get-random-values`
// (as `@arki/lock` requires). Without it the collection is refused with a clear error; this smoke
// then installs a test-only source.
let refusal = "has a random source";
if (typeof globalThis.crypto?.getRandomValues !== "function") {
  try {
    createMemoryCollection(memoryConfig);
    refusal = "created without a random source";
  } catch (error) {
    refusal = /random number generator|171/.test(String(error?.message))
      ? "refused"
      : String(error?.message);
  }
  // Stands in for the app's polyfill. Smoke only: Math.random is not a secure source.
  globalThis.crypto = {
    getRandomValues(bytes) {
      for (let i = 0; i < bytes.length; i++)
        bytes[i] = Math.floor(Math.random() * 256);
      return bytes;
    },
  };
}

const items = createMemoryCollection(memoryConfig);
await items.preload();
const inserted = items.insert({ id: "b", name: "Babbage" });
await inserted.isPersisted.promise;

// A local collection keeps rows in the global `localStorage` where one exists (a browser, or React
// Native after `import 'expo-sqlite/localStorage/install'`), else in memory as on a server. With
// the default `syncBetweenTabs`, it must not listen on a `window` that has no events.
const fakeStorage = new Map();
if (isHermes) {
  // Stands in for `expo-sqlite/localStorage/install`: the same Storage methods, kept in memory.
  globalThis.localStorage = {
    getItem: (key) => fakeStorage.get(key) ?? null,
    setItem: (key, value) => void fakeStorage.set(key, String(value)),
    removeItem: (key) => void fakeStorage.delete(key),
    clear: () => fakeStorage.clear(),
    key: (index) => [...fakeStorage.keys()][index] ?? null,
    get length() {
      return fakeStorage.size;
    },
  };
}
const notes = createLocalCollection({
  storageKey: "smoke:notes",
  schema: itemSchema,
  getKey: (item) => item.id,
});
// A sync that throws (a listener on a `window` without events) fails the check, not the whole file,
// so the timers stop below and the engine ends. A sync that never gets ready fails after 2 s.
let notesStatus;
try {
  await Promise.race([
    notes.stateWhenReady(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  notesStatus = notes.status;
  if (notesStatus === "ready") {
    await notes.insert({ id: "n1", name: "first" }).isPersisted.promise;
  }
} catch (error) {
  notesStatus = String(error);
}
const hasGlobalStorage =
  isHermes ||
  (typeof window !== "undefined" && typeof window.localStorage !== "undefined");
const storedNotes = hasGlobalStorage
  ? globalThis.localStorage.getItem("smoke:notes")
  : undefined;

const checks = [
  ["memory collection holds its initial row", items.get("a")?.name, "Ada"],
  [
    "without a random source a collection is refused (React Native), else built",
    refusal,
    isHermes ? "refused" : "has a random source",
  ],
  ["with a random source a write lands", items.get("b")?.name, "Babbage"],
  ["local collection gets ready", notesStatus, "ready"],
  ["local collection holds its row", notes.get("n1")?.name, "first"],
  [
    "local collection writes through the global localStorage when there is one",
    hasGlobalStorage ? storedNotes?.includes("first") : storedNotes,
    hasGlobalStorage ? true : undefined,
  ],
];

// Stop the collections' garbage-collection timers, so engines without process.exit end.
await items.cleanup();
await notes.cleanup();

const runtime = isHermes
  ? "hermes"
  : typeof Deno !== "undefined"
    ? `deno ${Deno.version.deno}`
    : typeof Bun !== "undefined"
      ? `bun ${Bun.version}`
      : typeof navigator !== "undefined" &&
          navigator.userAgent &&
          !navigator.userAgent.includes("Node")
        ? `browser ${navigator.userAgent}`
        : `node ${globalThis.process?.version ?? ""}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(
      `FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== "undefined") globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
if (typeof globalThis.process !== "undefined") globalThis.process.exit(0);
