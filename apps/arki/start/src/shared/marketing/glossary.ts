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
    text: 'Adds the ways into the app. Here that is the clock and TanStack Start.',
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
    text: 'Reads the row in a new transaction, then writes the events the rule returns, with the reducer, inline projections and queued jobs in the same transaction.',
    where: 'F4 · Remember · J-001',
  },
  CommandConflict: {
    text: 'A typed failure for a rule that says no, here "already paid". The command returns it as a value and nothing is written.',
    where: 'F4 · Remember · J-001',
  },
  CommandNotFound: {
    text: 'A typed failure for a row that does not exist. Returned, not thrown.',
    where: 'F4 · Remember · J-001',
  },
  startOn: {
    text: "Starts the workflow run from a domain event, inside that event's transaction. The run id comes from the entity id.",
    where: 'F4 · Remember · J-001',
  },
  step: {
    text: 'One checkpoint of a workflow. Every completed step is a row in journal_events.',
    where: 'F4 · Remember · J-001',
    method: true,
  },
  idempotencyKey: {
    text: 'The same on every try of this step, so a repeated call gets the first refund back.',
    where: 'F4 · Remember · J-001',
  },
  waitFor: {
    text: 'Parks the run until the named signal arrives, at most three days here. No worker is busy while it waits.',
    where: 'F4 · Remember · J-001',
    method: true,
  },
  signal: {
    text: "The name of the signal that wakes the run. Stripe's refund-settled webhook sends it, as a command.",
    where: 'F4 · Remember · J-001',
  },
  onTimeout: {
    text: "What happens when no signal comes in time. 'continue' runs the next step, which asks Stripe.",
    where: 'F4 · Remember · J-001',
  },
  runCommand: {
    text: 'Runs a journal command. The webhook uses it to send the signal, so the signal is a row like any other.',
    where: 'F4 · Remember · J-001',
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
