// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. No Redis or Postgres server: the runtime-local backend runs
// pg-boss on an in-memory PGlite, so a job is really queued, picked up and run.
// Entries: root and ./runtime-local (a job runs), ./errors, ./contract, ./types,
// ./projection, ./dot, ./outbox (error codes), ./foreman (failed-job schema).

import { PGlite } from "@electric-sql/pglite";

import { z } from "@arki/contracts";
import { isFailure } from "@arki/failure";

import { CronPatterns, initQueue } from "../dist/index.js";
import { QUEUE_DEFINITION_ERROR_CODES } from "../dist/errors.js";
import { JOB_TRIGGER_FAILURES, queueJobId } from "../dist/contract.js";
import { QUEUE_PRIORITIES } from "../dist/types/index.js";
import { createRuntimeLocalQueueInstance } from "../dist/runtime-local/index.js";
import { project } from "../dist/projection.js";
import {
  QUEUE_ACTION_META_SCHEMA,
  QUEUE_PLUGIN_ERROR_CODES,
} from "../dist/dot.js";
import { isOutboxError, OUTBOX_ERROR_CODES } from "../dist/outbox/index.js";
import { failedJobSchema } from "../dist/foreman/index.js";

const q = initQueue.context().create();
const seen = [];
const job = q.job
  .name("smoke-greet")
  .input(z.object({ who: z.string() }))
  .handler(async (data) => {
    seen.push(data.who);
  });

const pglite = new PGlite();
const instance = createRuntimeLocalQueueInstance({
  pglite,
  createContext: () => ({}),
});
await instance.register(q.registry({ job }));
await instance.start();
const accepted = await job.trigger({ who: "Ada" });
for (let attempt = 0; attempt < 60 && seen.length === 0; attempt++)
  await new Promise((resolve) => setTimeout(resolve, 100));
await instance.stop();
await pglite.close();

const definitionError = (fn) => {
  try {
    fn();
    return "no error";
  } catch (error) {
    return error?.code ?? "wrong error";
  }
};
const missingName = definitionError(() =>
  q.job
    .name("")
    .input(z.object({}))
    .handler(async () => {}),
);
const badCron = definitionError(() => CronPatterns.everyMinutes(0));

const topology = project({
  app: { name: "smoke" },
  actions: [
    {
      id: "greet.consume",
      plugin: "queue",
      binding: "queue",
      direction: "in",
      address: "smoke-greet",
      metaSchema: QUEUE_ACTION_META_SCHEMA,
      meta: {},
    },
    { id: "http.get", plugin: "http", binding: "http", direction: "in" },
  ],
});

const jobId = queueJobId.create();
const badFailed = failedJobSchema.safeParse({ id: 1 });

const checks = [
  ["trigger is accepted", isFailure(accepted), false],
  ["the queued job ran its handler with the input", seen.join(","), "Ada"],
  [
    "a job with an empty name is refused at definition",
    missingName,
    QUEUE_DEFINITION_ERROR_CODES.invalidJobName,
  ],
  [
    "out of range cron helper input is refused",
    badCron,
    QUEUE_DEFINITION_ERROR_CODES.invalidCronValue,
  ],
  ["cron helper builds a pattern", CronPatterns.everyMinutes(5), "*/5 * * * *"],
  [
    "trigger failures are listed for contracts",
    Object.keys(JOB_TRIGGER_FAILURES).length > 0,
    true,
  ],
  [
    "priorities are exported",
    Array.isArray(QUEUE_PRIORITIES) || typeof QUEUE_PRIORITIES === "object",
    true,
  ],
  [
    "queue job ids are created and recognised",
    !isFailure(jobId) && queueJobId.is(jobId),
    true,
  ],
  [
    "projection lists the queue with its consumer",
    topology.queues
      .map((entry) => `${entry.name}:${entry.consumers.length}`)
      .join(","),
    "smoke-greet:1",
  ],
  [
    "plugin error codes exist",
    Object.keys(QUEUE_PLUGIN_ERROR_CODES).length > 0,
    true,
  ],
  [
    "outbox error codes exist",
    typeof OUTBOX_ERROR_CODES.notInTransaction,
    "string",
  ],
  [
    "a plain error is not an outbox error",
    isOutboxError(new Error("x")),
    false,
  ],
  ["foreman refuses a malformed failed-job row", badFailed.success, false],
];

const engine =
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

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== "undefined") globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== "undefined") globalThis.process.exit(0);
