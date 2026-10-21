import type { ReactNode } from 'react';
import { useState } from 'react';

import {
  excerptCaption,
  WIRE_ERROR,
  WIRE_ERROR_SOURCE,
  WIRE_FIX,
  WIRE_MISTAKE,
  WIRE_MISTAKE_MARK,
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

/** The mistake line, marked: a wavy underline under the part the compiler refuses, a cloud around the line. */
function Mistake() {
  const [{ lines }] = WIRE_MISTAKE.parts;
  const [before = '', after = ''] = lines[0].split(WIRE_MISTAKE_MARK);
  return (
    <figure className="home-code">
      <figcaption>{excerptCaption(WIRE_MISTAKE)}</figcaption>
      <pre>
        <code>
          <span className="home-rev">
            <RevisionMark number={1} />
            <HighlightedText text={before} />
            <span className="home-wrong">
              <HighlightedText text={WIRE_MISTAKE_MARK} />
            </span>
            <HighlightedText text={after} />
          </span>
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
              <pre>{WIRE_ERROR.text}</pre>
            </div>
            <p className="home-ok">
              No type check? The kernel catches it at configure, before any boot hook runs: ARKI_DOT_E020, and its
              message names both positions.
            </p>
          </>
        )}
      </div>
      <p className="home-note">
        <code>.use()</code> adds one unit; <code>.infra()</code>, <code>.features()</code> and{' '}
        <code>.entrypoints()</code> add a group.
      </p>
    </DrawingSheet>
  );
}
