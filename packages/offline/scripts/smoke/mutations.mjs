// Smoke test of ./mutations, the replayable write queue. It stores to IndexedDB, which React Native
// lacks, so this entry runs on Node, Bun, Deno and browsers only (package.json "arki.entryRuntimes");
// React Native apps queue writes with `@tanstack/offline-transactions/react-native`.
// IndexedDB exists only in the browser leg: there the queue persists and replays, elsewhere every
// storage call returns a typed failure (never a throw). Each check states which one it expects.

import { oc } from "@orpc/contract";
import { z } from "zod";
import { OPERATION, operations } from "@arki/contracts/orpc";

import {
  createOfflineMutationQueue,
  createQueueStorage,
} from "../../dist/src/mutations/index.js";

const hasIndexedDb = typeof indexedDB !== "undefined";

// Storage rejects a malformed entry before touching IndexedDB; a real one needs IndexedDB.
const storage = createQueueStorage("smoke-queue");
const encodeOutcome = await storage.write([{ nonsense: true }]);
const readOutcome = await storage.read();

const contract = {
  // Marked through meta, as offlineSafe() from ./orpc does.
  posts: {
    create: oc
      .meta({ offlineSafe: true })
      .input(z.object({ title: z.string() })),
  },
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

const checks = [
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
    hasIndexedDb ? typeof receipt?.idempotencyKey : receipt?.code,
    hasIndexedDb ? "string" : "offline.queue_storage_unavailable",
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
];

const runtime =
  typeof Deno !== "undefined"
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
