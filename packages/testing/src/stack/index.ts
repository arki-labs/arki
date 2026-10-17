/**
 * `@arki/testing/stack` — the real services a test run needs, declared once per app.
 *
 * A service has two moments. `start` runs once per run, in the runner process (`globalSetup`).
 * `slice` runs once per worker, in the worker, and gives that worker its own piece (a database
 * cloned from a template, a Mailpit container). Values that cross processes must be JSON: the
 * runner writes them into one env variable (`ARKI_STACK`) and every worker reads them back.
 */

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/** A running piece. `stop` can be called any number of times. */
export type Started<T> = { readonly value: T; readonly stop: () => Promise<void> };

export type StartContext = {
  /** Unique per run. Services use it to name containers and databases. */
  readonly runId: string;
};

export type WorkerContext = { readonly runId: string; readonly workerIndex: number };

/** `run`: started once per run. `worker`: a new piece for every worker. */
export type ServiceScope = 'run' | 'worker';

export type ServiceSpec<TRun extends Json, TWorker extends Json = TRun> = {
  readonly name: string;
  readonly scope: ServiceScope;
  /** Once per run, in the runner. A failed start must leave nothing running. */
  start(ctx: StartContext): Promise<Started<TRun>>;
  /** Once per worker. Without it, every worker shares the run value. */
  slice?(run: TRun, ctx: WorkerContext): Promise<Started<TWorker>>;
};

/** Writes a service. Method syntax in the type keeps every spec assignable to the stack's map. */
export function service<TRun extends Json, TWorker extends Json = TRun>(
  spec: ServiceSpec<TRun, TWorker>,
): ServiceSpec<TRun, TWorker> {
  return spec;
}

export type ServiceMap = Readonly<Record<string, ServiceSpec<Json, Json>>>;
type RunOf<S> = S extends ServiceSpec<infer R, Json> ? R : never;
type WorkerOf<S> = S extends ServiceSpec<Json, infer W> ? W : never;

export type RunValues<M extends ServiceMap> = { readonly [K in keyof M]: RunOf<M[K]> };
export type WorkerValues<M extends ServiceMap> = { readonly [K in keyof M]: WorkerOf<M[K]> };
export type Env = Readonly<Record<string, string>>;

export type StackOptions<M extends ServiceMap> = {
  readonly services: M;
  /** The env the app server and the in-process app boot with. `origin` is the worker's server URL. */
  readonly env: (worker: WorkerValues<M>, context: { readonly origin: string }) => Env;
};

/** What crosses the process boundary: the run values and the run id. Plain JSON. */
export type StackManifest = {
  readonly runId: string;
  readonly run: Readonly<Record<string, Json>>;
};

export type WorkerSlice<M extends ServiceMap> = {
  readonly values: WorkerValues<M>;
  /** The env for a server that will listen at `origin`. */
  envFor(origin: string): Env;
  stop(): Promise<void>;
};

export type AttachedStack<M extends ServiceMap> = {
  worker(workerIndex: number): Promise<WorkerSlice<M>>;
};

export type RunningStack<M extends ServiceMap> = AttachedStack<M> & {
  readonly manifest: StackManifest;
  stop(): Promise<void>;
};

export type Stack<M extends ServiceMap> = {
  readonly services: M;
  /** Runner side: start every service. */
  start(ctx: StartContext): Promise<RunningStack<M>>;
  /** Worker side: use the run values the runner already started. */
  attach(manifest: StackManifest): AttachedStack<M>;
};

export const STACK_ENV_KEY = 'ARKI_STACK';

function isJsonRecord(value: unknown): value is Readonly<Record<string, Json>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the manifest the runner put in `process.env.ARKI_STACK`. The one place it is validated. */
export function readManifest(raw: string | undefined = process.env[STACK_ENV_KEY]): StackManifest {
  if (raw === undefined || raw === '') {
    throw new Error(
      `STACK_NOT_STARTED: ${STACK_ENV_KEY} is empty. The stack starts in Playwright's globalSetup; ` +
        'run the tests through `playwright test`, or start the stack first.',
    );
  }
  const parsed: unknown = JSON.parse(raw);
  const runId: unknown = isJsonRecord(parsed) ? parsed['runId'] : undefined;
  const run: unknown = isJsonRecord(parsed) ? parsed['run'] : undefined;
  if (typeof runId !== 'string' || !isJsonRecord(run)) {
    throw new Error(`STACK_MANIFEST_INVALID: ${STACK_ENV_KEY} must be {"runId": string, "run": object}.`);
  }
  return { runId, run };
}

export function defineStack<const M extends ServiceMap>(options: StackOptions<M>): Stack<M> {
  const entries = Object.entries(options.services);

  function attachTo(runId: string, run: StackManifest['run']): AttachedStack<M> {
    return {
      async worker(workerIndex) {
        const slices: (readonly [string, Started<Json>, boolean])[] = [];
        try {
          for (const [key, spec] of entries) {
            const runValue = run[key];
            if (runValue === undefined) throw new Error(`STACK_VALUE_MISSING: no run value for service "${key}".`);
            if (spec.slice === undefined) {
              slices.push([key, { value: runValue, stop: () => Promise.resolve() }, false]);
            } else {
              slices.push([key, await spec.slice(runValue, { runId, workerIndex }), true]);
            }
          }
        } catch (error) {
          for (const [, slice, owned] of slices.toReversed()) if (owned) await slice.stop();
          throw error;
        }
        // Erasure seam: the record is assembled by key at runtime; `WorkerValues<M>` is its exact type.
        const values = Object.fromEntries(slices.map(([key, slice]) => [key, slice.value])) as WorkerValues<M>;
        return {
          values,
          envFor: origin => options.env(values, { origin }),
          async stop() {
            for (const [, slice, owned] of slices.toReversed()) if (owned) await slice.stop();
          },
        };
      },
    };
  }

  return {
    services: options.services,
    async start(ctx) {
      const started = new Map<string, Started<Json>>();
      try {
        // Services start one after another so a failure stops exactly the ones already up.
        for (const [key, spec] of entries) started.set(key, await spec.start(ctx));
      } catch (error) {
        for (const running of [...started.values()].toReversed()) await running.stop();
        throw error;
      }
      const run = Object.fromEntries([...started].map(([key, running]) => [key, running.value]));
      const attached = attachTo(ctx.runId, run);
      return {
        manifest: { runId: ctx.runId, run },
        worker: workerIndex => attached.worker(workerIndex),
        async stop() {
          for (const running of [...started.values()].toReversed()) await running.stop();
        },
      };
    },
    attach: manifest => attachTo(manifest.runId, manifest.run),
  };
}
