import type { ReactNode } from 'react';

import type { BuildStep, Excerpt } from './build-steps';
import {
  DEFINE_APP,
  DEFINE_STEP,
  EXPLAIN_COMMAND,
  EXPLAIN_GRAPH_OUTPUT,
  FEATURE_NEEDS,
  FEATURE_ROOMS,
  FEATURE_STEP,
  FEATURE_USECASE,
  INSPECT_STEP,
  REMEMBER_STEP,
  SERVE_APP,
  SERVE_STEP,
  START_IN_TEST,
  WIRE_STEP,
} from './build-steps';
import { Code } from './code';
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

function Excerpts({ excerpts }: Readonly<{ excerpts: readonly Excerpt[] }>) {
  return excerpts.map((excerpt, index) => <Code key={index} excerpt={excerpt} />);
}

/** The six build steps, foundation first. */
export function BuildPath() {
  return (
    <div className="home-steps">
      <Step step={DEFINE_STEP} index={0}>
        <p className="home-step-text">
          Importing this file opens nothing. Infra, features and entrypoints are listed in boot order.
        </p>
        <Callout step={DEFINE_STEP}>
          <Code excerpt={DEFINE_APP} />
        </Callout>
      </Step>

      <Step step={WIRE_STEP} index={1}>
        <p className="home-step-text">
          A unit may only come after the units it needs. The order is a type. This floor has its own sheet.
        </p>
        <WireSheet />
      </Step>

      <Step step={FEATURE_STEP} index={2}>
        <p className="home-step-text">
          The needs block is typed handles from the infra. <code>entrypointOnly</code> hides the database from usecases.
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
          <Excerpts excerpts={[FEATURE_NEEDS, FEATURE_USECASE]} />
        </Callout>
      </Step>

      <Step step={REMEMBER_STEP} index={3}>
        <JournalChapter />
      </Step>

      <Step step={SERVE_STEP} index={4}>
        <p className="home-step-text">The web layer is an entrypoint of the app. It names what it needs.</p>
        <Callout step={SERVE_STEP}>
          <Code excerpt={SERVE_APP} />
        </Callout>
      </Step>

      <Step step={INSPECT_STEP} index={5}>
        <p className="home-step-text">
          <code>dot explain</code> configures the app and prints its manifest. It never boots. A test starts the real
          app.
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
          <Code excerpt={START_IN_TEST} />
        </Callout>
      </Step>
    </div>
  );
}
