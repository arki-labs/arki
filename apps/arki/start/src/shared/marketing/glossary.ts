/**
 * The words of the code on the homepage that explain themselves on hover, focus or tap. Each sentence says only what
 * the excerpts and the docs next to them say. `where` names the floor, or sheet, the word belongs to.
 */
export type GlossaryEntry = {
  text: string;
  where: string;
  /** Only a call after a dot, such as `.use(`. Without it the word counts wherever it names something. */
  method?: true;
};

export const GLOSSARY = {
  defineApp: {
    text: 'Starts an app with a name. What follows is added in boot order; importing the file opens nothing.',
    where: 'F1 · Define',
  },
  infra: {
    text: 'Adds a group of infrastructure units, such as the database, the cache and the mail client, in the order listed.',
    where: 'F1 · Define',
    method: true,
  },
  features: {
    text: 'Adds a group of features after the infra they need.',
    where: 'F1 · Define',
    method: true,
  },
  entrypoints: {
    text: 'Adds the ways into the app. Here that is the clock, the RPC gateway and TanStack Start.',
    where: 'F1 · Define',
    method: true,
  },
  use: {
    text: 'Adds one unit. A unit may only come after the units it needs; swap them and the compiler refuses.',
    where: 'F2 · Wire · A-101',
    method: true,
  },
  needs: {
    text: 'Names the services this feature needs, as typed handles taken from the infra.',
    where: 'F3 · Feature',
  },
  entrypointOnly: {
    text: 'Hides a service from usecases. The store binds db and the limiter binds kv; usecases never see them.',
    where: 'F3 · Feature',
  },
  Pick: {
    text: 'A TypeScript type: the usecase takes only the pieces of its dependencies that it lists, so it can use nothing else.',
    where: 'F3 · Feature',
  },
  tanstackStart: {
    text: 'The web entrypoint. It names the services it needs and gives every route a typed session and rpc client.',
    where: 'F5 · Serve',
  },
  orThrow: {
    text: 'Takes a result that may be a failure and returns the value, or throws the failure.',
    where: 'F6 · Inspect',
  },
  write: {
    text: 'Locks the row, then writes the events the rule returns. The row, the inline projections and the queued jobs follow in the same transaction.',
    where: 'F4 · Remember · J-101',
  },
  CommandConflict: {
    text: 'A typed failure for a rule that says no, such as "already paid", or for an idempotency key reused with another input. It is returned as a value, and nothing is written.',
    where: 'F4 · Remember · J-101, J-102',
  },
  CommandNotFound: {
    text: 'A typed failure for a row that does not exist. Returned, not thrown.',
    where: 'F4 · Remember · J-101',
  },
  step: {
    text: 'One step of a workflow. A checkpoint event is written before and after it runs, so after a restart the run goes on from there.',
    where: 'F4 · Remember · J-104',
    method: true,
  },
  idempotencyKey: {
    text: 'The key the mail provider dedupes on. Here it is the job id, the same on every try of the job.',
    where: 'F4 · Remember · J-101',
  },
  waitFor: {
    text: 'Parks the run until the named signal arrives, at most three days here. No worker is busy while it waits.',
    where: 'F4 · Remember · J-104',
    method: true,
  },
  signal: {
    text: "The name of the signal that wakes the run. The provider's webhook sends it.",
    where: 'F4 · Remember · J-104',
  },
} as const satisfies Record<string, GlossaryEntry>;

const ENTRIES: ReadonlyMap<string, GlossaryEntry> = new Map(Object.entries<GlossaryEntry>(GLOSSARY));

const NAMING_KINDS: ReadonlySet<string> = new Set(['call', 'method', 'prop', 'key', 'type', 'plain']);

/** The glossary entry for a token, or undefined. `kind` is the token's kind from `highlight.ts`. */
export function glossaryEntry(text: string, kind: string): GlossaryEntry | undefined {
  const entry = ENTRIES.get(text);
  if (entry === undefined || !NAMING_KINDS.has(kind)) return undefined;
  if (entry.method === true && kind !== 'method') return undefined;
  return entry;
}
