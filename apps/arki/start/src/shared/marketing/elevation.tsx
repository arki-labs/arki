import type { RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '@arki/ui/cn';

import { BUILD_STEPS } from './build-steps';

/** The side elevation, drawn in SVG units: a tower crane beside a six-floor building, foundation at the bottom. */
const DRAWING = {
  width: 360,
  floorHeight: 62,
  roofY: 70,
  firstFloorY: 80,
  boxX: 100,
  boxWidth: 208,
  jibY: 16,
  jibHeight: 9,
  hookX: 190,
  bubbleSize: 30,
  restDrop: 10,
  archWidth: 14,
  archHeight: 26,
} as const;

const groundY = DRAWING.firstFloorY + BUILD_STEPS.length * DRAWING.floorHeight;
const drawingHeight = groundY + 22;
const jibBottom = DRAWING.jibY + DRAWING.jibHeight;

/** Top edge of a floor. Floor 0 (the foundation) is the lowest one. */
function floorTop(index: number): number {
  return DRAWING.firstFloorY + (BUILD_STEPS.length - 1 - index) * DRAWING.floorHeight;
}

/** How far the crane lowers the bubble to the middle of a floor. A fractional floor lies between two floors. */
function floorDrop(floor: number): number {
  return floorTop(floor) + DRAWING.floorHeight / 2 - jibBottom - DRAWING.bubbleSize / 2;
}

/**
 * How far the crane lowers the bubble once `progress` (0–1) of floor `floor`'s section is read, or a short hang above
 * the roof before the first floor (-1). The bubble is on a floor's middle halfway through its section and on the line
 * between two floors as the next section starts, so it moves with every scroll, however long a floor is.
 */
function craneDrop(floor: number, progress: number): number {
  if (floor < 0) return DRAWING.restDrop;
  return floorDrop(Math.min(Math.max(floor + progress - 0.5, 0), BUILD_STEPS.length - 1));
}

/** The nearest ancestor that scrolls. On this site the page scrolls inside `.marketing`, not in the window. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return null;
}

/** Where, as a share of the view, a floor counts as the one being read. */
const READING_LINE = 0.4;

/**
 * The floor whose section has reached the reading line (-1 until the first one does), and the crane lowered to the
 * reading position. It is worked out from the scroll position of the element that really scrolls, not from an
 * IntersectionObserver: that one's `rootMargin` is ignored inside a cross-origin frame and depends on which element is
 * the root, and a lit floor must not hinge on it. The cable and the bubble are moved on the drawing itself every frame,
 * so a scroll re-renders nothing; React state changes only when another floor lights.
 */
function useCrane(
  stage: RefObject<HTMLElement | null>,
  cable: RefObject<SVGRectElement | null>,
  load: RefObject<SVGGElement | null>,
): number {
  const [active, setActive] = useState(-1);
  useEffect(() => {
    const home = stage.current;
    if (home === null) return;
    const sections = [...home.querySelectorAll<HTMLElement>('[data-floor]')];
    let frame = 0;
    const update = () => {
      frame = 0;
      // Found on every frame: before the page CSS lands, nothing above `.home` scrolls yet.
      const scroller = scrollParent(home);
      const top = scroller?.getBoundingClientRect().top ?? 0;
      const height = scroller?.clientHeight ?? window.innerHeight;
      const line = top + height * READING_LINE;
      let floor = -1;
      let progress = 0;
      for (const [index, section] of sections.entries()) {
        const box = section.getBoundingClientRect();
        if (box.top > line) continue;
        floor = index;
        progress = box.height > 0 ? Math.min((line - box.top) / box.height, 1) : 1;
      }
      setActive(floor);
      const drop = craneDrop(floor, progress);
      cable.current?.style.setProperty('transform', `scaleY(${drop})`);
      load.current?.style.setProperty('transform', `translateY(${drop}px)`);
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    update();
    // Scroll events do not bubble; caught on the way down, any scroller's scroll reaches this one listener.
    document.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', schedule, { capture: true });
      window.removeEventListener('resize', schedule);
    };
  }, [stage, cable, load]);
  return active;
}

function archPath(centerX: number, baseY: number): string {
  const half = DRAWING.archWidth / 2;
  const shoulder = baseY - DRAWING.archHeight + half;
  return `M${centerX - half} ${baseY}V${shoulder}A${half} ${half} 0 0 1 ${centerX + half} ${shoulder}V${baseY}`;
}

type ElevationProps = {
  /** The page root holding the `[data-floor]` sections the floors stand for. */
  stage: RefObject<HTMLElement | null>;
};

/** The crane at rest. `useCrane` moves it every frame; React renders this once, as the value never changes. */
const REST_DROP = craneDrop(-1, 0);

export function Elevation({ stage }: Readonly<ElevationProps>) {
  const cable = useRef<SVGRectElement>(null);
  const load = useRef<SVGGElement>(null);
  const active = useCrane(stage, cable, load);
  const label = `Side elevation of a building with ${BUILD_STEPS.length} floors, one for each build step below. Floors with a full sheet carry its sheet number. The floor you are reading is lit and a crane lowers the bubble to it.`;

  return (
    <aside className="home-side" aria-label="Side elevation">
      <div className="home-sheet">
        <div className="home-sheet-head">
          <span>Side elevation</span>
          <span>Floor in view is lit</span>
        </div>
        <svg className="home-elevation" viewBox={`0 0 ${DRAWING.width} ${drawingHeight}`} role="img" aria-label={label}>
          <defs>
            <pattern id="home-truss" width="8" height="8" patternUnits="userSpaceOnUse">
              <path d="M0 8L8 0M0 0L8 8" className="home-truss-line" />
            </pattern>
            <pattern id="home-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
              <path d="M0 0V7" className="home-hatch-line" />
            </pattern>
          </defs>
          <rect
            className="home-mast"
            x="330"
            y={DRAWING.jibY}
            width="12"
            height={groundY - DRAWING.jibY}
            fill="url(#home-truss)"
          />
          <rect
            className="home-jib"
            x="150"
            y={DRAWING.jibY}
            width="192"
            height={DRAWING.jibHeight}
            fill="url(#home-truss)"
          />
          <line
            className="home-outline"
            x1={DRAWING.boxX}
            x2={DRAWING.boxX + DRAWING.boxWidth}
            y1={DRAWING.roofY}
            y2={DRAWING.roofY}
          />
          {BUILD_STEPS.map((step, index) => {
            const top = floorTop(index);
            const bottom = top + DRAWING.floorHeight;
            const slot = DRAWING.boxWidth / step.excerpts.length;
            return (
              <g
                key={step.id}
                className={cn('home-floor', index <= active && 'is-built', index === active && 'is-now')}
              >
                <rect
                  className="home-floor-box"
                  x={DRAWING.boxX}
                  y={top}
                  width={DRAWING.boxWidth}
                  height={DRAWING.floorHeight}
                />
                <text className="home-floor-number" x={DRAWING.boxX - 8} y={bottom - 20} textAnchor="end">
                  {step.number}
                </text>
                <text className="home-floor-name" x={DRAWING.boxX - 8} y={bottom - 7} textAnchor="end">
                  {step.verb}
                </text>
                {step.sheet === undefined ? null : (
                  <text
                    className="home-floor-tag"
                    x={DRAWING.boxX + DRAWING.boxWidth - 4}
                    y={top + 10}
                    textAnchor="end"
                  >
                    {step.sheet}
                  </text>
                )}
                {step.excerpts.map((_, arch) => (
                  <path key={arch} className="home-arch" d={archPath(DRAWING.boxX + slot * (arch + 0.5), bottom)} />
                ))}
              </g>
            );
          })}
          <rect
            className="home-ground"
            x={DRAWING.boxX}
            y={groundY}
            width={DRAWING.boxWidth}
            height="12"
            fill="url(#home-hatch)"
          />
          <line
            className="home-outline"
            x1={DRAWING.boxX}
            x2={DRAWING.boxX + DRAWING.boxWidth}
            y1={groundY}
            y2={groundY}
          />
          <rect
            ref={cable}
            className="home-cable"
            x={DRAWING.hookX}
            y={jibBottom}
            width="1"
            height="1"
            style={{ transform: `scaleY(${REST_DROP})` }}
          />
          <g ref={load} className="home-load" style={{ transform: `translateY(${REST_DROP}px)` }}>
            <image
              className="home-load-bubble"
              href="/assets/elevation/bubble.webp"
              x={DRAWING.hookX - DRAWING.bubbleSize / 2}
              y={jibBottom}
              width={DRAWING.bubbleSize}
              height={DRAWING.bubbleSize}
            />
          </g>
        </svg>
        <nav className="home-strip" aria-label="Build steps">
          {BUILD_STEPS.map((step, index) => (
            <a
              key={step.id}
              href={`#step-${step.id}`}
              className={cn('home-strip-cell', index <= active && 'is-built', index === active && 'is-now')}
              aria-current={index === active ? 'step' : undefined}
              aria-label={`${step.number} ${step.verb}`}
            >
              {step.number}
            </a>
          ))}
        </nav>
        <p className="home-caption">1 arch = 1 code excerpt · A-xxx and J-xxx = a full sheet on that floor</p>
      </div>
    </aside>
  );
}
