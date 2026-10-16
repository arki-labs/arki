// @arki/live: fan-out, freshness strategies and writer overhead.
// Run: `bun run bench` (explore) or `bun run bench --profile publish --write-readme`.
//
// Three kinds of group:
//
// - Timed fan-out and reconnect storm (`fanout.ts`): a commit hint reaches N open streams, through
//   the hub's feed and through `liveEndpoint` + `createLiveClient`. Contract-checked: every stream
//   must get exactly the expected frame. Delivery percentiles at 1 000 streams are repeated metrics.
// - Deterministic freshness metrics (`workload.ts`): Lane A (live Query) against Lane B (live
//   query collection), invalidate-everything and `refetchInterval` polling, on one seeded workload
//   in virtual time. Origin queries, wasted fetches and staleness are counts, not timings.
// - Timed writer overhead (`writer.ts`): single-row, bulk and multi-table commits on PGlite, with
//   no triggers, the table triggers and the scoped triggers; and one statement over 1, 1 000 and
//   100 000 rows of 200 tenants.
//
// Not benchmarked:
// - SSE parser against `@microsoft/fetch-event-source`: that package is not in the workspace
//   catalog and this suite adds no external dependency.
// - An Electric collection (TanStack DB row sync): it needs `wal_level=logical` and the Electric
//   sync service, which cannot run here without new services.

import { compare, defineSuite, metric } from '@arki/bench';

import type { Commit, Delivered, Fanout, Resumed } from './fanout.js';
import type { Outcome, Strategy, Workload } from './workload.js';
import {
  commits,
  expectedFrame,
  expectedResume,
  fanout,
  percentile,
  stormDrained,
  stormEndpoint,
  stormHub,
} from './fanout.js';
import { mean, outcome, workloads } from './workload.js';
import { database, INSERTS, ITEMS, ROWS } from './writer.js';

const STORM_STREAMS = 1000;
const DELIVERY_STREAMS = 1000;
/** Commits per delivery-percentile observation. */
const DELIVERY_COMMITS = 20;

const paths = {
  hub: { label: 'hub feed (hub.open)', package: '@arki/live' },
  endpoint: { label: 'liveEndpoint + createLiveClient (SSE, grant filter)', package: '@arki/live', variant: true },
} as const;

function fanoutGroup(streams: number) {
  const send = async (path: 'hub' | 'endpoint', commit: Commit): Promise<readonly Delivered[]> => {
    const fixture: Fanout = await fanout(path, streams);
    return fixture.commit(commit);
  };
  return compare<Commit>({
    id: `fanout-${streams}`,
    title: `One commit to ${streams.toLocaleString('en-US')} open stream${streams === 1 ? '' : 's'}`,
    contract: {
      id: 'fanout/v1',
      description: `each of the ${streams} streams gets exactly one change frame naming the committed table and its receipt, with a cursor`,
    },
    inputs: commits,
    expected: commit => Array.from({ length: streams }, () => expectedFrame(commit)),
    baseline: 'hub',
    mode: 'async',
    note: 'Every row includes the hub batch window (batchMs = 1, the smallest allowed). The replay ring stays under its frame cap: at most 1 000 frames per second, kept 10 s.',
    cases: c => ({
      hub: c({ ...paths.hub, run: (commit: Commit) => send('hub', commit) }),
      endpoint: c({ ...paths.endpoint, run: (commit: Commit) => send('endpoint', commit) }),
    }),
  });
}

function deliveryGroup(fraction: number) {
  const name = `p${Math.round(fraction * 100)}`;
  /** One observation: the `fraction` percentile of every stream's arrival time over `DELIVERY_COMMITS` commits. */
  const collect = async (path: 'hub' | 'endpoint'): Promise<number> => {
    const fixture = await fanout(path, DELIVERY_STREAMS);
    const arrivals: number[] = [];
    for (let index = 0; index < DELIVERY_COMMITS; index += 1) {
      const commit = commits[index % commits.length] ?? { table: 'posts', txid: '1' };
      arrivals.push(...(await fixture.timedCommit(commit)));
    }
    return percentile(arrivals, fraction);
  };
  return metric({
    id: `delivery-${name}`,
    title: `Commit hint to frame, ${name} over ${DELIVERY_STREAMS.toLocaleString('en-US')} streams`,
    unit: 'ms',
    deterministic: false,
    baseline: 'hub',
    note: 'Measured from the hint entering the hub to each stream holding its frame; includes the 1 ms batch window.',
    cases: {
      hub: { label: paths.hub.label, package: paths.hub.package, collect: () => collect('hub') },
      endpoint: { label: paths.endpoint.label, package: paths.endpoint.package, collect: () => collect('endpoint') },
    },
  });
}

const stormGroup = compare<number>({
  id: `reconnect-storm-${STORM_STREAMS}`,
  title: `${STORM_STREAMS.toLocaleString('en-US')} streams resume at once and replay 16 frames`,
  contract: {
    id: 'storm/v1',
    description: 'every stream begins with resume and replays the 16 missed frames in order',
  },
  inputs: [STORM_STREAMS],
  expected: streams => ({ resumed: Array.from({ length: streams }, () => expectedResume()), drained: true }),
  baseline: 'hub',
  mode: 'async',
  note: 'Every stream opens the same cursor (one AES-GCM open each) and detaches after the replay. The contract check also proves every stream detached.',
  cases: c => ({
    hub: c({
      ...paths.hub,
      run: (streams: number) => stormHub(streams),
      normalize: async (resumed: readonly Resumed[]) => ({ resumed, drained: await stormDrained() }),
    }),
    endpoint: c({
      ...paths.endpoint,
      run: (streams: number) => stormEndpoint(streams),
      normalize: async (resumed: readonly Resumed[]) => ({ resumed, drained: await stormDrained() }),
    }),
  }),
});

const strategies: Record<Strategy, { readonly label: string; readonly package?: string }> = {
  live: { label: 'Lane A: live Query (invalidate by table)', package: '@arki/live' },
  'live-scoped': { label: 'Lane A, scoped hints (per-tenant grants)', package: '@arki/live' },
  collection: { label: 'Lane B: live query collection (TanStack DB)', package: '@tanstack/query-db-collection' },
  'invalidate-all': { label: 'same hints, invalidate everything' },
  'poll-1s': { label: 'refetchInterval 1 s', package: '@tanstack/react-query' },
  'poll-5s': { label: 'refetchInterval 5 s', package: '@tanstack/react-query' },
};
const strategyKeys: readonly Strategy[] = ['live', 'live-scoped', 'collection', 'invalidate-all', 'poll-1s', 'poll-5s'];

function freshnessGroup(
  workload: Workload,
  id: string,
  title: string,
  unit: string,
  measure: (result: Outcome) => number,
  note: string,
) {
  const cases = Object.fromEntries(
    strategyKeys.map(key => [key, { ...strategies[key], collect: async () => measure(await outcome(workload, key)) }]),
  );
  return metric({
    id: `${id}-${workload.id}`,
    title: `${title}, ${workload.tenants} tenants`,
    unit,
    deterministic: true,
    baseline: 'live',
    note,
    cases,
  });
}

const freshness = workloads.flatMap(workload => [
  freshnessGroup(
    workload,
    'origin-queries',
    'Origin queries per commit',
    'queries/commit',
    result => result.fetches / result.commits,
    'Every refetch the clients send to the server, after the first load, divided by the commits.',
  ),
  freshnessGroup(
    workload,
    'wasted-fetches',
    'Wasted fetches per commit',
    'fetches/commit',
    result => result.wasted / result.commits,
    'Refetches whose answer equalled what the client already had. Table hints refetch every tenant and every input of a table.',
  ),
  freshnessGroup(
    workload,
    'staleness-mean',
    'Mean staleness',
    'ms',
    result => mean(result.staleness),
    'From the commit that changed a watched result to the client asking again (virtual time; origin answers at once).',
  ),
  freshnessGroup(
    workload,
    'staleness-p99',
    'Staleness p99',
    'ms',
    result => percentile(result.staleness, 0.99),
    'The 99th percentile of the same staleness samples.',
  ),
]);

const writerCases = {
  'no-triggers': { label: 'no triggers (Postgres alone)', package: '@electric-sql/pglite' },
  triggers: { label: 'with @arki/live triggers + listener', package: '@arki/live' },
  scoped: { label: 'with @arki/live scoped triggers (org) + listener', package: '@arki/live', variant: true },
} as const;

function writerGroup<Input>(
  id: string,
  title: string,
  inputs: readonly Input[],
  rows: (input: Input) => number,
  write: (writer: Awaited<ReturnType<typeof database>>, input: Input) => Promise<number>,
) {
  return compare<Input>({
    id,
    title,
    contract: { id: `${id}/v1`, description: 'the commit updates exactly the expected rows' },
    inputs,
    expected: rows,
    baseline: 'no-triggers',
    mode: 'async',
    cases: c => ({
      'no-triggers': c({
        ...writerCases['no-triggers'],
        run: async (input: Input) => write(await database('none'), input),
      }),
      triggers: c({ ...writerCases.triggers, run: async (input: Input) => write(await database('tables'), input) }),
      scoped: c({ ...writerCases.scoped, run: async (input: Input) => write(await database('scoped'), input) }),
    }),
  });
}

export default defineSuite({
  id: '@arki/live',
  intro:
    'What a commit costs and what it buys. Fan-out times one commit hint reaching every open stream, through the hub feed and through the SSE endpoint and client, with cursor sealing on real WebCrypto. The freshness groups count, on one seeded multi-tenant workload in virtual time, the origin queries, wasted fetches and staleness of live invalidation (Lane A), a TanStack DB query collection over the same hints (Lane B), invalidate-everything and `refetchInterval` polling. The writer groups time commits on PGlite with and without the live triggers.',
  notes: [
    'Fan-out rows include the hub batch window (batchMs = 1). Real apps run the default 20 ms, which adds to every delivery and lowers the frame rate.',
    'The `endpoint` rows are in process: `liveEndpoint(...).fetch` read by `createLiveClient`, no sockets. Their grant names every table, so the filter runs on every tag and drops none.',
    'Choosing `replayEnvelopes` (the overload cap, one envelope per transaction): set it ≥ replayMs / 1000 × the peak commits per second, and `replayBytes` above that many envelopes of about 64 bytes plus their keys. Reaching either starts a new epoch and every client resets.',
    'Freshness metrics are deterministic counts from a seeded commit log: 0.5 commits per tenant per second for 30 s, half of them on the hot `likes` table; one tab per tenant with six queries. Table hints name tables, not rows or tenants, so one tenant’s write refetches every tenant’s queries on that table. Scoped hints (`live-scoped`) scope all four tables by tenant: each tab’s stream is projected through its own grant by the real hub, so only the writer’s tenant refetches. The run fails above 3.0 origin queries per commit or on any fetch outside the writer’s tenant.',
    'Lane B refetches the same queries as Lane A: a query collection is fed by the same TanStack query. What it adds is row-level diffing and cross-collection live queries on the client, not fewer origin queries.',
    'Not measured: an Electric collection (needs `wal_level=logical` and the Electric sync service), and an SSE parser comparison against `@microsoft/fetch-event-source` (not in the workspace catalog).',
    'Writer groups use UPDATE so tables keep their size; the statement trigger fires once per statement, so the bulk group updates 1 000 rows with one hint. Scoped triggers send one hint per distinct key: 200 for the 1 000-row and 100 000-row statements. The one-row insert group is the scoped-trigger cost lane (plan T13 expects the scoped row under twice the table-trigger row once the commit is counted); it is timed here, alone, never in the parallel test suite. Numbers pending an idle run.',
  ],
  groups: [
    fanoutGroup(1),
    fanoutGroup(100),
    fanoutGroup(1000),
    deliveryGroup(0.5),
    deliveryGroup(0.95),
    deliveryGroup(0.99),
    stormGroup,
    ...freshness,
    writerGroup(
      'writer-single-row',
      'Commit: one row',
      [1, 250, 500, 999],
      () => 1,
      (writer, id) => writer.single(id),
    ),
    writerGroup(
      'writer-bulk',
      `Commit: ${ROWS.toLocaleString('en-US')} rows in one statement`,
      [ROWS],
      rows => rows,
      writer => writer.bulk(),
    ),
    writerGroup(
      'writer-insert-one-row',
      `Commit: insert one row into a table of ${INSERTS.toLocaleString('en-US')} rows`,
      [3, 77, 150],
      () => 1,
      (writer, org) => writer.insertOne(org),
    ),
    writerGroup(
      'writer-rows',
      `Commit: 1, ${ROWS.toLocaleString('en-US')} or ${ITEMS.toLocaleString('en-US')} rows of 200 tenants in one statement`,
      [1, 1000, ITEMS],
      rows => rows,
      (writer, rows) => writer.items(rows),
    ),
    writerGroup(
      'writer-multi-table',
      'Commit: one row in each of three tables',
      [2, 300, 700],
      () => 3,
      (writer, id) => writer.multi(id),
    ),
  ],
});
