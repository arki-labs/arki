import { packageDocHref } from '~/features/site-data/package-urls';
import { WAVES } from './build-steps';
import { Code } from './code';
import { MODEL_HEADLINE, MODEL_PARTS } from './model-excerpts';

type AppCard = {
  name: string;
  text: string;
  /** Where the claim can be checked. */
  source?: string;
};

/** Apps that use arki and what each shows. Every claim here can be checked in the app's code. */
const APPS = [
  {
    name: 'avocabo',
    text: 'Newsletter digest. 26 features, one Dot chain, TanStack Start as the front door.',
    source: 'apps/avocabo/backend/src/app.ts',
  },
  {
    name: 'kapodopera',
    text: "Payments. The refund workflow starts from RefundApproved and waits for Stripe's signal.",
    source: 'apps/kapodopera/backend/src/features/_shared/payments/journal.ts',
  },
  {
    name: 'everseek',
    text: 'Webhooks write to the journal as the system actor.',
    source: 'apps/everseek/backend/src/core/run-command.ts',
  },
  {
    name: 'games-platform',
    text: 'Taps fan out realtime after commit, so subscribers never hear a rolled-back change.',
    source: 'apps/games-platform/backend/src/journal.root.ts',
  },
  {
    name: 'foreman',
    text: 'Trust changes as journal events, with an atomic staleness check: a stale write returns CommandConflict.',
    source: 'apps/foreman/backend/src/features/enrollment/journal.ts',
  },
  {
    name: 'faultline',
    text: 'Small demo. The test starts the real app.',
    source: 'demos/faultline/backend/src/app.ts',
  },
] as const satisfies readonly AppCard[];

const QUICKSTART_HREF = packageDocHref('dot', 'next', 'docs/quickstart');
const AGENT_GUIDE_HREF = packageDocHref('dot', 'next', 'docs/agent-guide');

const NOT_FOR = [
  'You need a web server or a router. Dot composes services; serve HTTP with TanStack Start, Hono or oRPC.',
  'You want plugins loaded from disk or config. Dot never auto-loads.',
  'The program has one or two services. A function with try/finally is shorter.',
  'You need a scope per request. Dot has one service graph per app.',
  'You are building a shed. A shed needs no blueprint.',
] as const;

/** The mental model: what a function returns, what a unit needs, and who owns running work. */
export function MentalModel() {
  return (
    <section className="home-band" aria-labelledby="home-model">
      <p className="home-kicker">
        <b>Structure</b> · the mental model
      </p>
      <h2 id="home-model">{MODEL_HEADLINE}</h2>
      <p className="home-step-text">
        Most code is now written by an agent and read by one. So the rules live in the compiler, the lint rule and the
        test, not in a convention someone has to remember. A function returns its value or a failure. A unit declares
        what it needs. Work runs in a scope that owns it. The explicit form is the point: no magic, nothing to unwrap,
        no runtime to learn.
      </p>
      <div className="home-model">
        {MODEL_PARTS.map(part => (
          <div key={part.name}>
            <b>{part.name}</b>
            <p>{part.text}</p>
            <Code excerpt={part.excerpt} />
          </div>
        ))}
      </div>
    </section>
  );
}

/** "Built with arki": the apps behind the code on this page. */
export function BuiltWith() {
  return (
    <section className="home-band" aria-labelledby="home-proof">
      <p className="home-kicker">
        <b>Nameplate</b> · real apps
      </p>
      <h2 id="home-proof">Built with arki</h2>
      <div className="home-cards">
        {APPS.map(app => (
          <div className="home-card" key={app.name}>
            <strong>{app.name}</strong>
            <p>{app.text}</p>
            {'source' in app ? (
              <p>
                <code>{app.source}</code>
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

/** The packages by release wave, from the foundation up. */
export function Materials() {
  return (
    <section className="home-band" aria-labelledby="home-materials">
      <p className="home-kicker">
        <b>Materials</b> · {WAVES.length} release waves
      </p>
      <h2 id="home-materials">The packages, by wave.</h2>
      <p className="home-step-text">Every wave depends only on the waves below it. Import one and stop there.</p>
      <div className="home-waves">
        {WAVES.map((wave, index) => (
          <div className="home-wave" key={wave.name}>
            <span className="home-wave-name">{`W${index + 1} · ${wave.name}`}</span>
            <span className="home-wave-title">{wave.title}</span>
            <ul className="home-packages" aria-label={`${wave.name} packages`}>
              {wave.packages.map(name => (
                <li key={name}>@arki/{name}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Where to start, and when not to. */
export function StartHere() {
  return (
    <section className="home-band" aria-labelledby="home-start">
      <p className="home-kicker">
        <b>Site office</b> · where to start
      </p>
      <h2 id="home-start">Start small. Grow by composition.</h2>
      <div className="home-start">
        <div>
          <ol>
            <li>Install the kernel.</li>
            <li>
              Scaffold an app with <code>dot new</code>. You get an env plugin and a boot test.
            </li>
            <li>Read the quickstart. It breaks the app on purpose and reads the error.</li>
          </ol>
          <code className="home-install">bun add @arki/dot</code>
          <div className="home-links">
            <a href={QUICKSTART_HREF}>Quickstart</a>
            <a href={AGENT_GUIDE_HREF}>Dot for agents</a>
            <a href="/errors">Error codes</a>
          </div>
        </div>
        <div className="home-not">
          <strong>When not to use this</strong>
          <ul>
            {NOT_FOR.map(text => (
              <li key={text}>{text}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
