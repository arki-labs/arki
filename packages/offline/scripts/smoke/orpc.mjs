// Smoke test of ./orpc: the offline-safe marker, and the idempotency middleware on server engines.
// oRPC needs Web Streams (TransformStream), which React Native lacks, so this entry runs on Node,
// Bun, Deno and browsers only (package.json "arki.entryRuntimes").

import { oc } from "@orpc/contract";
import { createRouterClient, implement } from "@orpc/server";
import { z } from "zod";

import * as offlineOrpc from "@arki/offline/orpc";

const hasServerExports = typeof window === "undefined";
const contract = {
  posts: {
    create: offlineOrpc.offlineSafe(oc.input(z.object({ title: z.string() }))),
  },
};

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

const checks = [
  ["offlineSafe marks the contract", marked["~orpc"].meta.offlineSafe, true],
  [
    "idempotency: server engines replay the stored answer, browser has no middleware",
    typeof offlineOrpc.idempotency === "function"
      ? `${middlewareRuns}:${secondOutcome?.id}`
      : "none",
    hasServerExports ? "1:post_1" : "none",
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
