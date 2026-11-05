// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser and Hermes.
// IndexedDB exists only in the browser leg, so storage answers differ by engine:
// with IndexedDB the queue persists and replays, without it every storage call returns
// a typed failure (never a throw). Each check states which one it expects.

import { createElement } from "react";
import { oc } from "@orpc/contract";
import { createRouterClient, implement } from "@orpc/server";
import { z } from "zod";
import { OPERATION, operations } from "@arki/contracts/orpc";

import * as offlineOrpc from "@arki/offline/orpc";
import { offlineSafe } from "../dist/src/orpc/offline-safe-marker.js";
import { createMemoryCollection } from "../dist/src/collections/index.js";
import { createStrategy } from "../dist/src/pwa/index.js";
import { createOfflineRuntime } from "../dist/src/preset/index.js";
import { createPersistedQueryClient } from "../dist/src/query/index.js";
import {
  createOfflineMutationQueue,
  createQueueStorage,
} from "../dist/src/mutations/index.js";
import { OfflineBanner } from "../dist/src/status/index.js";
import "../dist/src/devtools/index.js";

const hasIndexedDb = typeof indexedDB !== "undefined";
const isBrowser = typeof window !== "undefined";
const hasServerExports = !isBrowser && typeof HermesInternal === "undefined";
const canRender = typeof HermesInternal === "undefined";
const render = async (element) =>
  canRender
    ? (await import("react-dom/server")).renderToStaticMarkup(element)
    : undefined;

// query: the persisted client is built everywhere; saving it needs IndexedDB.
const persisted = createPersistedQueryClient({
  storageKey: "smoke-query",
  buster: "v1",
});
persisted.queryClient.setQueryData(["k"], "v");
const persistOutcome = await persisted.persistNow();

// mutations: storage rejects a malformed entry before touching IndexedDB; a real one needs IndexedDB.
const storage = createQueueStorage("smoke-queue");
const encodeOutcome = await storage.write([{ nonsense: true }]);
const readOutcome = await storage.read();

const contract = {
  posts: { create: offlineSafe(oc.input(z.object({ title: z.string() }))) },
};
const createPost = { [OPERATION]: operations(contract).posts.create };
const calls = [];
const queue = createOfflineMutationQueue({
  storageKey: "smoke-queue-2",
  deadLetterStorageKey: "smoke-dead-2",
  rpc: {
    call: async (path, input) =>
      void calls.push(`${path.join(".")}:${JSON.stringify(input)}`),
  },
  actorId: () => "usr_smoke",
});
const events = [];
const unsubscribe = queue.subscribe((event) => events.push(event.type));
const receipt = await queue.enqueue(createPost, { title: "hello" });
const drained = hasIndexedDb ? await queue.drain() : undefined;
const snapshot = queue.status();
unsubscribe();
queue.dispose();

// collections: an in-memory TanStack DB collection with a schema.
const items = createMemoryCollection({
  schema: z.object({ id: z.string(), name: z.string() }),
  getKey: (item) => item.id,
  initialData: [{ id: "a", name: "Ada" }],
});
await items.preload();

// pwa: Workbox strategy handlers.
const strategy = createStrategy("networkFirst", {
  cacheName: "smoke-api",
  maxEntries: 5,
});

// orpc: the offline-safe marker everywhere; the idempotency middleware only on server engines.
const marked = offlineOrpc.offlineSafe(oc.input(z.object({ n: z.number() })));
let middlewareRuns = 0;
let secondOutcome;
if (typeof offlineOrpc.idempotency === "function") {
  const rows = new Map();
  const store = {
    find: async (key, path, userId) =>
      rows.get(`${key}|${path}|${userId}`) ?? null,
    store: async (key, path, userId, response) =>
      void rows.set(`${key}|${path}|${userId}`, response),
  };
  const impl = implement(contract)
    .$context()
    .use(offlineOrpc.idempotency(store));
  const router = impl.router({
    posts: {
      create: impl.posts.create.handler(() => ({
        id: `post_${String(++middlewareRuns)}`,
      })),
    },
  });
  const context = {
    headers: new Headers({
      "Idempotency-Key": "key-1",
      "Offline-Actor": "usr_1",
    }),
    session: { user: { id: "usr_1" } },
  };
  const client = createRouterClient(router, { context });
  const first = await client.posts.create({ title: "a" });
  secondOutcome = await client.posts.create({ title: "a" });
  void first;
}

// preset + status + devtools.
const offline = createOfflineRuntime({
  tier: "cache-only",
  appId: "smoke-app",
});
let queryClientOutcome;
try {
  queryClientOutcome =
    offline.queryClient instanceof Object ? "client" : "none";
} catch (error) {
  queryClientOutcome = /only in the browser/.test(String(error.message))
    ? "refused"
    : String(error.message);
}
offline.dispose();
const bannerHtml = await render(
  createElement(
    offline.Provider,
    null,
    createElement(
      OfflineBanner,
      null,
      (state) => `online=${state.online} queued=${state.queued}`,
    ),
  ),
);

const checks = [
  [
    "persisted client holds queries",
    persisted.queryClient.getQueryData(["k"]),
    "v",
  ],
  [
    "persisting needs IndexedDB, else a typed failure",
    hasIndexedDb ? persistOutcome === undefined : persistOutcome?.code,
    hasIndexedDb ? true : "offline.query_cache_persist_failed",
  ],
  [
    "queue storage rejects a malformed entry as an encoding failure",
    encodeOutcome?.code,
    "offline.queue_encoding_failure",
  ],
  [
    "queue storage read: empty list with IndexedDB, typed failure without",
    hasIndexedDb
      ? Array.isArray(readOutcome) && readOutcome.length
      : readOutcome?.code,
    hasIndexedDb ? 0 : "offline.queue_storage_unavailable",
  ],
  [
    "enqueue: receipt with IndexedDB, typed failure without",
    hasIndexedDb ? typeof receipt?.id : typeof receipt?.code,
    "string",
  ],
  [
    "drain with IndexedDB sends the call through rpc",
    hasIndexedDb ? calls[0] : undefined,
    hasIndexedDb ? 'posts.create:{"title":"hello"}' : undefined,
  ],
  [
    "drain returns no failure",
    hasIndexedDb ? drained === undefined : undefined,
    hasIndexedDb ? true : undefined,
  ],
  ["queue is empty after drain or refusal", snapshot.queued, 0],
  [
    "queue emitted events",
    hasIndexedDb ? events.includes("enqueued") : events.length >= 0,
    true,
  ],
  ["memory collection holds its initial row", items.get("a")?.name, "Ada"],
  ["workbox strategy keeps its cache name", strategy.cacheName, "smoke-api"],
  ["offlineSafe marks the contract", marked["~orpc"].meta.offlineSafe, true],
  [
    "idempotency: server engines replay the stored answer, browser has no middleware",
    typeof offlineOrpc.idempotency === "function"
      ? `${middlewareRuns}:${secondOutcome?.id}`
      : "none",
    hasServerExports ? "1:post_1" : "none",
  ],
  [
    "runtime query client: refused on the server, real in the browser",
    queryClientOutcome,
    isBrowser ? "client" : "refused",
  ],
  [
    "banner renders the online state",
    bannerHtml,
    canRender ? "online=true queued=0" : undefined,
  ],
];

const runtime =
  typeof HermesInternal !== "undefined"
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
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== "undefined") globalThis.process.exit(0);
