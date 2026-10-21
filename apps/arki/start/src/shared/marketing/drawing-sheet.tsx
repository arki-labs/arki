import type { ReactNode } from 'react';
import { Fragment, useState } from 'react';

import {
  excerptCaption,
  FEATURE_NEEDS,
  FEATURE_USECASE,
  gapBefore,
  WIRE_ERROR,
  WIRE_ERROR_SOURCE,
  WIRE_FIX,
  WIRE_MISTAKE,
  WIRE_MISTAKE_MARK,
  WIRE_UNITS,
} from './build-steps';
import { Code, HighlightedText } from './code';
import { useHydrated } from './use-hydrated';

type Point = readonly [x: number, y: number];

/** A revision cloud: scallops along the four sides of a box, drawn the way an architect circles a change. */
function cloudPath(width: number, height: number): string {
  const topLeft: Point = [2, 2];
  const topRight: Point = [width - 2, 2];
  const bottomRight: Point = [width - 2, height - 2];
  const bottomLeft: Point = [2, height - 2];
  const sides: readonly (readonly [Point, Point])[] = [
    [topLeft, topRight],
    [topRight, bottomRight],
    [bottomRight, bottomLeft],
    [bottomLeft, topLeft],
  ];
  let path = 'M2 2';
  for (const [[x1, y1], [x2, y2]] of sides) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const scallops = Math.max(1, Math.round(length / 13));
    const radius = ((length / scallops) * 0.62).toFixed(1);
    for (let step = 1; step <= scallops; step += 1) {
      const x = (x1 + ((x2 - x1) * step) / scallops).toFixed(1);
      const y = (y1 + ((y2 - y1) * step) / scallops).toFixed(1);
      path += `A${radius} ${radius} 0 0 1 ${x} ${y}`;
    }
  }
  return path;
}

const CLOUD = cloudPath(600, 40);

/** Draws the revision cloud and its numbered triangle around the line it sits in. */
function RevisionMark({ number }: Readonly<{ number: number }>) {
  return (
    <>
      <svg className="home-cloud" viewBox="0 0 600 40" preserveAspectRatio="none" aria-hidden="true">
        <path d={CLOUD} />
      </svg>
      <svg className="home-revtag" viewBox="0 0 22 18" aria-hidden="true">
        <polygon points="0,18 11,0 22,18" />
        <text x="11" y="15" textAnchor="middle">
          {number}
        </text>
      </svg>
    </>
  );
}

type DrawingSheetProps = {
  headingId: string;
  /** The sheet number in the title block, such as `A-101`. */
  sheet: string;
  title: string;
  /** Rows of the title block, label first. */
  block: readonly (readonly [label: string, value: string])[];
  children: ReactNode;
};

/** An architect's sheet: the drawing on the left, the title block with the sheet number on the right. */
export function DrawingSheet({ headingId, sheet, title, block, children }: Readonly<DrawingSheetProps>) {
  return (
    <article className="home-drawing" aria-labelledby={headingId}>
      <div className="home-draw">
        <h3 id={headingId}>{title}</h3>
        {children}
      </div>
      <aside className="home-titleblock" aria-label={`Title block ${sheet}`}>
        <table>
          <tbody>
            {block.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="home-sheetno">
          <small>Sheet</small>
          {sheet}
        </p>
      </aside>
    </article>
  );
}

type DrawingIndexProps = {
  /** The index's own sheet name, such as `A-000 · Guide index`. */
  label: string;
  /** The right-hand note in the head. */
  meta: string;
  /** One `<tr>` per sheet: number, title, what it shows. */
  children: ReactNode;
};

/** Sheet A-000 of a drawing set: the index, read as a table of contents. */
export function DrawingIndex({ label, meta, children }: Readonly<DrawingIndexProps>) {
  return (
    <nav className="home-index" aria-label={label}>
      <h2 className="home-index-head">
        <span>{label}</span>
        <span>{meta}</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th scope="col">Sheet</th>
            <th scope="col">Title</th>
            <th scope="col">Shows</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </nav>
  );
}

/**
 * The four rooms of the avocabo waitlist feature, top floor first, as sheet A-201 cuts them. Every name is a file or
 * an export in `apps/avocabo/backend/src/features/waitlist`.
 */
const FEATURE_SECTION_ROOMS = [
  {
    name: 'entrypoints',
    rows: [
      ['files', 'procedures.ts, rpc.ts'],
      ['sees', 'usecases, db, kv'],
    ],
    text: 'The oRPC contract and its procedures. bind(waitlistLogic) puts the usecases on the handler context.',
  },
  {
    name: 'usecases',
    rows: [
      ['files', 'signup, counts, markInvited…'],
      ['sees', 'repos, limiter, turnstile, mailer'],
    ],
    text: 'The rules: signup, counts, listEntries, markInvited, publicCount, unsubscribeByToken. Each one picks the services it uses by key, never db or kv.',
  },
  {
    name: 'infra',
    rows: [
      ['files', 'store, repository, signup-limiter, turnstile'],
      ['binds', 'db, kv'],
    ],
    text: 'The store binds db, the signup limiter binds kv, turnstile checks the bot token. Private to the feature.',
  },
  {
    name: 'model',
    rows: [
      ['files', 'tables, schemas, statuses'],
      ['sees', 'nothing above'],
    ],
    text: 'Tables, schemas, statuses. Nothing here reads upward.',
  },
] as const;

type SectionRoom = (typeof FEATURE_SECTION_ROOMS)[number];

/** One floor of the section. Until the page is interactive it is drawn, not pressed: a button that does nothing is worse. */
function Room({ room, pressed, onPress }: Readonly<{ room: SectionRoom; pressed: boolean; onPress?: () => void }>) {
  const body = (
    <>
      <span className="home-seat" aria-hidden="true" />
      <h4>{room.name}</h4>
      <dl>
        {room.rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
    </>
  );
  return onPress === undefined ? (
    <div className="home-room">{body}</div>
  ) : (
    <button className="home-room" type="button" aria-pressed={pressed} onClick={onPress}>
      {body}
    </button>
  );
}

/**
 * Sheet A-201: one feature cut open, four rooms from the contract down to the tables. It reads in full without
 * JavaScript (the infra room is described); pressing a room once the page is interactive describes that one.
 */
export function FeatureSheet() {
  const hydrated = useHydrated();
  // The design opens on infra, the room `entrypointOnly` is about.
  const [shown, setShown] = useState<SectionRoom>(FEATURE_SECTION_ROOMS[2]);
  return (
    <DrawingSheet
      headingId="a-201-title"
      sheet="A-201"
      title="Section A–A: cut the waitlist feature open."
      block={[
        ['Project', 'arki'],
        ['Drawing', 'Section A–A'],
        ['Step', 'Feature'],
        ['Subject', 'waitlist'],
        ['Source', 'feature.ts, public-count.ts'],
      ]}
    >
      <p className="home-ctext">
        A feature names what it needs. <code>entrypointOnly</code> hides the database from usecases. A usecase picks its
        own dependencies by key.{hydrated ? ' Press a room to see what it holds.' : null}
      </p>
      <div className="home-secgrid">
        <Code excerpt={FEATURE_NEEDS} />
        <figure className="home-xsec" aria-label="The waitlist feature, four rooms from top to bottom">
          <div className="home-xb">
            <p className="home-xroof">
              <b>rpc</b> · the oRPC contract, mounted by the app&apos;s gateway
            </p>
            {FEATURE_SECTION_ROOMS.map(room => (
              <div key={room.name} className="home-xfloor">
                <Room room={room} pressed={room === shown} onPress={hydrated ? () => setShown(room) : undefined} />
              </div>
            ))}
          </div>
          <div className="home-xearth" aria-hidden="true" />
          <figcaption className="home-xnote" aria-live="polite">
            <b>{shown.name}</b>
            {shown.text}
          </figcaption>
        </figure>
      </div>
      <Code excerpt={FEATURE_USECASE} />
    </DrawingSheet>
  );
}

/** One line of the mistake. The line with the refused part gets a wavy underline under it and a cloud around it. */
function MistakeLine({ line }: Readonly<{ line: string }>) {
  if (!line.includes(WIRE_MISTAKE_MARK)) {
    return (
      <span className="home-ln">
        <HighlightedText text={line} />
      </span>
    );
  }
  const [before = '', after = ''] = line.split(WIRE_MISTAKE_MARK);
  return (
    <span className="home-rev">
      <RevisionMark number={1} />
      <HighlightedText text={before} />
      <span className="home-wrong">
        <HighlightedText text={WIRE_MISTAKE_MARK} />
      </span>
      <HighlightedText text={after} />
    </span>
  );
}

/** The mistake file: its imports, then the marked line. */
function Mistake() {
  return (
    <figure className="home-code">
      <figcaption>{excerptCaption(WIRE_MISTAKE)}</figcaption>
      <pre>
        <code>
          {WIRE_MISTAKE.parts.map((part, index) => (
            <Fragment key={part.id}>
              {gapBefore(WIRE_MISTAKE.parts[index - 1], part) ? (
                <span className="home-ln" aria-hidden="true">
                  {' '}
                </span>
              ) : null}
              {part.lines.map(line => (
                <MistakeLine key={line} line={line} />
              ))}
            </Fragment>
          ))}
        </code>
      </pre>
    </figure>
  );
}

const SWAP_ICON = 'M2 5h10M9 2l3 3-3 3M14 11H4M7 8l-3 3 3 3';

/**
 * Sheet A-101. It is drawn with the mistake and its compiler error, so it is complete without JavaScript. The toggle
 * is the enhancement: it puts the database first and shows the line that compiles.
 */
export function WireSheet() {
  const hydrated = useHydrated();
  const [fixed, setFixed] = useState(false);
  return (
    <DrawingSheet
      headingId="a-101-title"
      sheet="A-101"
      title="Elevation: providers below consumers."
      block={[
        ['Project', 'arki'],
        ['Drawing', 'Elevation'],
        ['Step', 'Wire'],
        ['Rev', fixed ? '0 · as drawn' : '1 · clouded'],
      ]}
    >
      <p className="home-ctext">
        <code>sessions</code> and <code>orders</code> both need <code>db</code>. The <code>database</code> unit provides
        it, so it must come first.
      </p>
      <Code excerpt={WIRE_UNITS} />
      {hydrated ? (
        <button
          className="home-toggle"
          type="button"
          aria-pressed={fixed}
          onClick={() => setFixed(previous => !previous)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d={SWAP_ICON} />
          </svg>
          Put the database first
        </button>
      ) : null}
      <div aria-live="polite">
        {fixed ? (
          <>
            <Code excerpt={WIRE_FIX} />
            <p className="home-ok">The type error is gone, and the kernel has nothing to say.</p>
          </>
        ) : (
          <>
            <Mistake />
            <div className="home-err">
              <p className="home-err-head">TypeScript · {WIRE_ERROR_SOURCE.path}</p>
              <pre>{WIRE_ERROR.lines.join('\n')}</pre>
            </div>
            <p className="home-ok">
              Plain JavaScript has no type check, so the kernel checks too. It stops the app at configure, before any
              boot hook runs. Its error, ARKI_DOT_E020, names both units and their positions.
            </p>
          </>
        )}
      </div>
      <p className="home-note">
        Every list boots left to right: <code>.infra()</code> first, then <code>.features([…])</code>, then{' '}
        <code>.entrypoints()</code>.
      </p>
    </DrawingSheet>
  );
}
