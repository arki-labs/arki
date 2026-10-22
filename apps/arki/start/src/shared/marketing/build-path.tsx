import type { ReactNode } from 'react';

import type { BuildStep } from './build-steps';
import type { Excerpt } from './excerpt';
import {
  DEFINE_APP,
  DEFINE_STEP,
  DEFINE_UNIT,
  DOCTOR_COMMAND,
  EXPLAIN_COMMAND,
  EXPLAIN_GRAPH_OUTPUT,
  FEATURE_NEEDS,
  FEATURE_ROOMS,
  FEATURE_STEP,
  FEATURE_USECASE,
  INSPECT_STEP,
  REMEMBER_STEP,
  SERVE_APP,
  SERVE_ROUTE,
  SERVE_SERVER,
  SERVE_STEP,
  START_IN_TEST,
  WIRE_STEP,
} from './build-steps';
import { Code, HighlightedText } from './code';
import { WireSheet } from './drawing-sheet';
import { JournalChapter } from './journal-chapter';

type StepProps = {
  step: BuildStep;
  index: number;
  children: ReactNode;
};

/** One floor of the building: the section the elevation lights while it is in view. */
function Step({ step, index, children }: Readonly<StepProps>) {
  return (
    <section className="home-step" id={`step-${step.id}`} data-floor={index} aria-labelledby={`step-${step.id}-title`}>
      <p className="home-kicker">
        <b>{step.number}</b> · {step.verb} · {step.kicker}
      </p>
      <h2 id={`step-${step.id}-title`}>{step.title}</h2>
      {children}
    </section>
  );
}

type CalloutProps = {
  step: BuildStep;
  children: ReactNode;
};

/** A small detail drawing: the code that shows the point of the floor. */
function Callout({ step, children }: Readonly<CalloutProps>) {
  return (
    <div className="home-callout">
      <div className="home-callout-head">
        <span>Detail · {step.verb}</span>
        <b>{`D-${step.number.slice(1)}`}</b>
      </div>
      {children}
    </div>
  );
}

type KeyRow = { readonly call: string; readonly meaning: string };

/** The three calls of avocabo's chain, in plain words: what each kind of unit is for. */
const CHAIN_KEY = [
  { call: '.infra(…)', meaning: 'What the app runs on: Postgres, a cache, mail, sign-in, locks.' },
  { call: '.features(…)', meaning: 'What the app does: its features, and the RPC gateway in front of them.' },
  { call: '.entrypoints(…)', meaning: 'How the world gets in: the web server and the cron clock.' },
] as const satisfies readonly KeyRow[];

/** The waitlist feature's calls, in plain words. */
const FEATURE_KEY = [
  { call: '.needs({…})', meaning: 'What the feature takes from the app: the database, the cache and the mailer.' },
  {
    call: 'entrypointOnly(…)',
    meaning: 'Only the feature’s own infra and entrypoints get this one. Its usecases never do.',
  },
  { call: '.infra(…)', meaning: 'The feature’s private services: a store, a rate limiter and a bot check.' },
  {
    call: "Pick<Deps, 'repos'>",
    meaning: 'A usecase names the services it uses. This one reads the repos and nothing else.',
  },
] as const satisfies readonly KeyRow[];

/** What a Start route finds on its request context. */
const CONTEXT_KEY = [
  { call: 'context.services', meaning: 'Every service the app provides, typed. Here, the waitlist’s unsubscribe.' },
  { call: 'context.rpc', meaning: 'The app’s RPC client. It calls the procedures in the same process.' },
  { call: 'context.session()', meaning: 'Who is calling, read from the request headers.' },
] as const satisfies readonly KeyRow[];

/** A key under the code: each call, then what it means in plain words. */
function CodeKey({ rows }: Readonly<{ rows: readonly KeyRow[] }>) {
  return (
    <dl className="home-chain-key">
      {rows.map(row => (
        <div key={row.call}>
          <dt>
            <HighlightedText text={row.call} />
          </dt>
          <dd>{row.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

function Excerpts({ excerpts }: Readonly<{ excerpts: readonly Excerpt[] }>) {
  return excerpts.map((excerpt, index) => <Code key={index} excerpt={excerpt} />);
}

/** The six build steps, foundation first. */
export function BuildPath() {
  return (
    <div className="home-steps">
      <Step step={DEFINE_STEP} index={0}>
        <p className="home-step-text">
          A Dot app is a list of units. Each unit says what it provides and how it shuts down. <code>start()</code>{' '}
          boots the list top to bottom; <code>dispose()</code> closes it bottom to top. If a unit is not in the chain,
          it does not run.
        </p>
        <Callout step={DEFINE_STEP}>
          <Code excerpt={DEFINE_UNIT} />
          <Code excerpt={DEFINE_APP} />
          <CodeKey rows={CHAIN_KEY} />
        </Callout>
      </Step>

      <Step step={WIRE_STEP} index={1}>
        <p className="home-step-text">
          Units boot in the order you list them. A unit that needs <code>db</code> must come after the unit that
          provides it. Swap them, and your editor rejects the line before anything runs.
        </p>
        <WireSheet />
      </Step>

      <Step step={FEATURE_STEP} index={2}>
        <p className="home-step-text">
          A feature holds one part of your app, like the waitlist. It says what it needs. Its own infra talks to the
          database. Its usecases, the rules, get only the services they ask for by name, so a test can swap each one for
          a fake.
        </p>
        <ul className="home-rooms" aria-label="The four rooms of a feature">
          {FEATURE_ROOMS.map(room => (
            <li key={room.name}>
              <b>{room.name}</b>
              <span>{room.text}</span>
            </li>
          ))}
        </ul>
        <Callout step={FEATURE_STEP}>
          <Code excerpt={FEATURE_NEEDS} />
          <CodeKey rows={FEATURE_KEY} />
          <Code excerpt={FEATURE_USECASE} />
        </Callout>
      </Step>

      <Step step={REMEMBER_STEP} index={3}>
        <JournalChapter headline={false} />
      </Step>

      <Step step={SERVE_STEP} index={4}>
        <p className="home-step-text">
          TanStack Start serves the web app, and it is one entrypoint in the chain. <code>startServer</code> starts the
          app once per process. Then every request gets the started app on <code>context</code>: its services, an RPC
          client and the caller’s session, all typed.
        </p>
        <Callout step={SERVE_STEP}>
          <Excerpts excerpts={[SERVE_SERVER, SERVE_APP, SERVE_ROUTE]} />
          <CodeKey rows={CONTEXT_KEY} />
        </Callout>
      </Step>

      <Step step={INSPECT_STEP} index={5}>
        <p className="home-step-text">
          <code>dot explain</code> prints every unit, what it needs and what it provides. It never boots, so no
          connection opens. <code>dot doctor</code> boots the app for real, then shuts it down. A test starts the same
          app you ship.
        </p>
        <Callout step={INSPECT_STEP}>
          <Code excerpt={EXPLAIN_COMMAND} />
          <figure className="home-code">
            <figcaption>
              Real output · <code>{EXPLAIN_GRAPH_OUTPUT.command}</code> run on avocabo (prelaunch). Built with arki. The
              first lines of 449.
            </figcaption>
            <pre>
              <code>
                {EXPLAIN_GRAPH_OUTPUT.lines.map((line, index) => (
                  <span key={index} className="home-ln">
                    {line}
                  </span>
                ))}
              </code>
            </pre>
          </figure>
          <Code excerpt={DOCTOR_COMMAND} />
          <Code excerpt={START_IN_TEST} />
        </Callout>
      </Step>
    </div>
  );
}
