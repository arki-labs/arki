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

/** How far the crane lowers the bubble: to the middle of the lit floor, or a short hang above the roof at rest. */
function bubbleDrop(active: number): number {
  if (active < 0) return DRAWING.restDrop;
  return floorTop(active) + DRAWING.floorHeight / 2 - jibBottom - DRAWING.bubbleSize / 2;
}

function archPath(centerX: number, baseY: number): string {
  const half = DRAWING.archWidth / 2;
  const shoulder = baseY - DRAWING.archHeight + half;
  return `M${centerX - half} ${baseY}V${shoulder}A${half} ${half} 0 0 1 ${centerX + half} ${shoulder}V${baseY}`;
}

type ElevationProps = {
  /** Index of the floor being read, or -1 before the first floor is reached. */
  active: number;
};

export function Elevation({ active }: Readonly<ElevationProps>) {
  const drop = bubbleDrop(active);
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
            className="home-cable"
            x={DRAWING.hookX}
            y={jibBottom}
            width="1"
            height="1"
            style={{ transform: `scaleY(${drop})` }}
          />
          <g className="home-load" style={{ transform: `translateY(${drop}px)` }}>
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
