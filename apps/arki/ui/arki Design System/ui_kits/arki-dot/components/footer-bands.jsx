// Five under-footer band variants. Non-ASCII (or only loosely so).
// Each is a full-bleed ~150px-tall band that lives below the StatusBar.
//
// Variants:
//   1. ticker    — horizontal scrolling package-info marquee
//   2. graph     — animated SVG dependency network (pulses along edges)
//   3. monitor   — live system-status bars (CPU / MEM / REQ / ERR)
//   4. kinetic   — huge cross-fading brand phrases (kinetic typography)
//   5. pipeline  — staggered CI build-pipeline rows with progress bars

const { useState: useS, useEffect: useE, useRef: useR, useMemo: useM } = React;

/* ============================================================
   1. TICKER  —  horizontal package-info marquee.
   Stock-ticker grammar adapted to a package catalog.
   Each row: name · version · size · status pill.
   Two rows scroll opposite directions for visual rhythm.
   ============================================================ */

const TICKER_ITEMS = [
  { name: "@arki/dot",         v: "v0.1.0",        s: "9.2 KB",  st: "ready"  },
  { name: "@arki/db",          v: "v0.1.0",        s: "14.4 KB", st: "ready"  },
  { name: "@arki/kv",          v: "v0.1.0",        s: "6.1 KB",  st: "ready"  },
  { name: "@arki/env",         v: "v0.1.0",        s: "4.3 KB",  st: "ready"  },
  { name: "@arki/auth",        v: "v0.0.9",        s: "11.2 KB", st: "canary" },
  { name: "@arki/queue",       v: "v0.1.0-rc.3",   s: "9.7 KB",  st: "canary" },
  { name: "@arki/rpc",         v: "v0.1.0-rc.1",   s: "7.4 KB",  st: "canary" },
  { name: "@arki/cli",         v: "v0.1.0",        s: "22.0 KB", st: "ready"  },
  { name: "@arki/diagnostics", v: "v0.1.0",        s: "5.8 KB",  st: "ready"  },
  { name: "@arki/start",       v: "v0.0.4",        s: "6.9 KB",  st: "alpha"  },
  { name: "@arki/codemod",     v: "v0.0.2",        s: "8.5 KB",  st: "alpha"  },
  { name: "@arki/types",       v: "v0.1.0",        s: "3.1 KB",  st: "ready"  },
];

function TickerRow({ items, reverse, speed }) {
  // duplicate items twice for seamless loop
  const doubled = [...items, ...items];
  return (
    <div className="ticker-track" style={{ animationDuration: speed + "s", animationDirection: reverse ? "reverse" : "normal" }}>
      {doubled.map((it, i) => (
        <span key={i} className="ticker-item">
          <span className="t-name">{it.name}</span>
          <span className="t-v">{it.v}</span>
          <span className="t-s">{it.s}</span>
          <span className={"t-pill t-" + it.st}>
            <span className="t-dot"></span>{it.st}
          </span>
        </span>
      ))}
    </div>
  );
}

function BandTicker() {
  return (
    <section className="band band-ticker" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">live</div>
        <div className="band-title">npm registry</div>
        <div className="band-sub">arki.dev/packages</div>
      </div>
      <div className="ticker-rows">
        <TickerRow items={TICKER_ITEMS} reverse={false} speed={60} />
        <TickerRow items={[...TICKER_ITEMS].reverse()} reverse={true} speed={75} />
      </div>
    </section>
  );
}

/* ============================================================
   2. GRAPH  —  animated SVG dependency network.
   Center: @arki/dot. Satellites: env, db, kv, auth, queue, rpc, cli.
   Edges carry traveling amber pulses at intervals.
   ============================================================ */

const GRAPH_NODES = [
  { id: "dot",   label: "@arki/dot",   x: 380, y: 75,  r: 22, kind: "kernel" },
  { id: "env",   label: "env",         x: 150, y: 38,  r: 13, kind: "ready"  },
  { id: "db",    label: "db",          x: 95,  y: 90,  r: 13, kind: "ready"  },
  { id: "kv",    label: "kv",          x: 150, y: 130, r: 13, kind: "ready"  },
  { id: "auth",  label: "auth",        x: 615, y: 38,  r: 13, kind: "canary" },
  { id: "queue", label: "queue",       x: 670, y: 90,  r: 13, kind: "canary" },
  { id: "rpc",   label: "rpc",         x: 615, y: 130, r: 13, kind: "canary" },
];
const GRAPH_EDGES = [
  ["dot","env"], ["dot","db"], ["dot","kv"],
  ["dot","auth"], ["dot","queue"], ["dot","rpc"],
];

function BandGraph() {
  const nodeById = useM(() => Object.fromEntries(GRAPH_NODES.map(n => [n.id, n])), []);
  // Generate per-edge pulse delays (staggered)
  const edges = useM(() => GRAPH_EDGES.map(([a,b], i) => ({
    a: nodeById[a], b: nodeById[b],
    delay: (i * 0.4).toFixed(2),
  })), [nodeById]);

  return (
    <section className="band band-graph" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">graph</div>
        <div className="band-title">plugin lattice</div>
        <div className="band-sub">dot explain --graph</div>
      </div>
      <svg viewBox="0 0 760 168" className="graph-svg" preserveAspectRatio="xMidYMid meet">
        {/* edges */}
        {edges.map((e, i) => (
          <g key={i}>
            <line x1={e.a.x} y1={e.a.y} x2={e.b.x} y2={e.b.y}
                  stroke="hsl(240 6% 18%)" strokeWidth="1" />
            {/* pulse */}
            <circle r="2.5" fill="hsl(43 96% 56%)">
              <animateMotion dur="2.8s" begin={e.delay + "s"} repeatCount="indefinite"
                             path={`M ${e.a.x} ${e.a.y} L ${e.b.x} ${e.b.y}`} />
              <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="2.8s" begin={e.delay + "s"} repeatCount="indefinite" />
            </circle>
          </g>
        ))}
        {/* nodes */}
        {GRAPH_NODES.map(n => (
          <g key={n.id}>
            <circle cx={n.x} cy={n.y} r={n.r}
                    fill={n.kind === "kernel" ? "hsl(43 96% 56% / 0.12)" : "var(--card)"}
                    stroke={
                      n.kind === "kernel" ? "hsl(43 96% 56%)" :
                      n.kind === "canary" ? "hsl(43 96% 60% / 0.5)" :
                      "hsl(240 6% 35%)"
                    } strokeWidth={n.kind === "kernel" ? 1.5 : 1} />
            {n.kind === "kernel" && (
              <circle cx={n.x} cy={n.y} r={n.r + 4}
                      fill="none" stroke="hsl(43 96% 56%)" strokeWidth="1" opacity="0.4">
                <animate attributeName="r" values={`${n.r+2};${n.r+10};${n.r+2}`} dur="3.2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.5;0;0.5" dur="3.2s" repeatCount="indefinite" />
              </circle>
            )}
            <text x={n.x} y={n.y + n.r + 14}
                  textAnchor="middle"
                  fill="var(--muted-foreground)"
                  fontFamily="var(--font-mono)"
                  fontSize={n.kind === "kernel" ? 11 : 10}>
              {n.label}
            </text>
          </g>
        ))}
      </svg>
    </section>
  );
}

/* ============================================================
   3. MONITOR  —  live system-status bars.
   Four rows: CPU, MEM, REQ/s, ERR/s. Each row a thin horizontal bar
   with a value that drifts via interval. Calm, dashboard-y.
   ============================================================ */

function MonitorRow({ label, color, base, jitter, suffix, decimals = 0 }) {
  const [val, setVal] = useS(base);
  useE(() => {
    const id = setInterval(() => {
      setVal(v => {
        const next = base + (Math.random() - 0.5) * jitter;
        // ease toward next
        return Math.max(0, +(v * 0.6 + next * 0.4).toFixed(decimals));
      });
    }, 700);
    return () => clearInterval(id);
  }, [base, jitter, decimals]);
  const pct = Math.min(100, (val / (base * 1.6)) * 100);
  return (
    <div className="mon-row">
      <div className="mon-label">{label}</div>
      <div className="mon-bar">
        <div className="mon-fill"
             style={{ width: pct + "%", background: color, transition: "width 700ms cubic-bezier(.16, 1, .3, 1)" }}>
        </div>
      </div>
      <div className="mon-val" style={{ color }}>
        {val.toFixed(decimals)}<span className="mon-unit">{suffix}</span>
      </div>
    </div>
  );
}

function BandMonitor() {
  return (
    <section className="band band-monitor" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">runtime</div>
        <div className="band-title">production</div>
        <div className="band-sub">us-east-1 · web-1</div>
      </div>
      <div className="mon-grid">
        <MonitorRow label="cpu"     color="hsl(43 96% 56%)"     base={37}   jitter={14}  suffix="%"     />
        <MonitorRow label="mem"     color="hsl(217 85% 65%)"    base={68}   jitter={6}   suffix="%"     />
        <MonitorRow label="req/s"   color="hsl(142 65% 55%)"    base={1240} jitter={400} suffix=""      />
        <MonitorRow label="err/s"   color="hsl(0 63% 60%)"      base={0.3}  jitter={0.4} suffix=""  decimals={2} />
      </div>
    </section>
  );
}

/* ============================================================
   4. KINETIC  —  giant cross-fading brand phrases.
   Cycles through arki's committed copy at huge size. Each phrase
   slides up from below, holds, slides up and out.
   ============================================================ */

const KINETIC_PHRASES = [
  { lead: "ship",     accent: "faster",   sub: "9.2 KB kernel · zero deps" },
  { lead: "build",    accent: "smarter",  sub: "typed plugin graph · structured diagnostics" },
  { lead: "type",     accent: "safe",     sub: "inference, not plumbing" },
  { lead: "agent",    accent: "native",   sub: "every page has a JSON envelope" },
  { lead: "show",     accent: "don't promise", sub: "every claim links to a fixture" },
  { lead: "peer",     accent: "respect",  sub: "adonis · elysia · hono · different jobs" },
];

function BandKinetic() {
  const [idx, setIdx] = useS(0);
  useE(() => {
    const id = setInterval(() => setIdx(i => (i + 1) % KINETIC_PHRASES.length), 2800);
    return () => clearInterval(id);
  }, []);
  const p = KINETIC_PHRASES[idx];

  return (
    <section className="band band-kinetic" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">{String(idx + 1).padStart(2, "0")} / {String(KINETIC_PHRASES.length).padStart(2, "0")}</div>
        <div className="band-title">manifest</div>
        <div className="band-sub">/philosophy</div>
      </div>
      <div className="kin-stage">
        <div className="kin-phrase" key={idx}>
          <span className="kin-lead">{p.lead}</span>
          <span className="kin-accent">{p.accent}</span>
          <span className="kin-dot">.</span>
        </div>
        <div className="kin-sub" key={"s"+idx}>{p.sub}</div>
      </div>
      <div className="kin-progress">
        {KINETIC_PHRASES.map((_, i) => (
          <div key={i} className={"kin-tick" + (i === idx ? " active" : "")}></div>
        ))}
      </div>
    </section>
  );
}

/* ============================================================
   5. PIPELINE  —  CI build-pipeline rows with progress bars.
   Five staggered rows (lint / typecheck / test / build / publish).
   Each row: progress fills 0→100% over its dur, then "passed",
   then briefly idle, then reset. Looks like a real GitHub Actions run.
   ============================================================ */

const PIPELINE_STEPS = [
  { name: "lint",        dur: 2.2, color: "var(--accent)",        sha: "eslint · 0 errors" },
  { name: "typecheck",   dur: 4.5, color: "var(--accent)",        sha: "tsc --noEmit · 0 errors" },
  { name: "test",        dur: 5.8, color: "var(--accent)",        sha: "vitest · 312 pass" },
  { name: "build",       dur: 3.6, color: "var(--accent)",        sha: "tsup · 9.2 KB" },
  { name: "pack",        dur: 1.8, color: "var(--accent)",        sha: "npm pack · 7 files" },
];

function PipelineRow({ step, offset }) {
  // Cycle: each row's pipeline takes (step.dur + 1.0) idle = total
  // Total loop: long enough to give all rows a settled period
  const TOTAL = 12;
  const startDelay = offset;     // sec
  const fillDur    = step.dur;   // sec
  const doneAt     = startDelay + fillDur;
  const idleUntil  = TOTAL;      // idle from doneAt until loop end

  return (
    <div className="pipe-row">
      <div className="pipe-step">
        <div className="pipe-marker"></div>
        <div className="pipe-name">{step.name}</div>
      </div>
      <div className="pipe-bar">
        <div className="pipe-fill" style={{
          animation: `pipe-fill ${TOTAL}s linear infinite`,
          animationDelay: (-offset) + "s",
          background: step.color,
        }}>
          <span className="pipe-fill-keyframes" data-fill={fillDur} data-total={TOTAL}></span>
        </div>
        <style>{`
          @keyframes pipe-fill-${step.name} {
            0%                                                { width: 0%;   opacity: 1; }
            ${((fillDur / TOTAL) * 100).toFixed(2)}%          { width: 100%; opacity: 1; }
            ${((fillDur / TOTAL) * 100 + 0.5).toFixed(2)}%    { width: 100%; opacity: 1; }
            ${((doneAt / TOTAL) * 100 + 8).toFixed(2)}%       { width: 100%; opacity: 0.5; }
            ${((doneAt / TOTAL) * 100 + 10).toFixed(2)}%      { width: 0%;   opacity: 0; }
            100%                                              { width: 0%;   opacity: 0; }
          }
        `}</style>
        <div className="pipe-fill-real" style={{
          animation: `pipe-fill-${step.name} ${TOTAL}s ${(-offset)}s linear infinite`,
          background: step.color,
        }}></div>
      </div>
      <div className="pipe-meta">{step.sha}</div>
    </div>
  );
}

function BandPipeline() {
  return (
    <section className="band band-pipeline" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">ci</div>
        <div className="band-title">release · 0.1.0</div>
        <div className="band-sub">build 802cf4e</div>
      </div>
      <div className="pipe-grid">
        {PIPELINE_STEPS.map((s, i) => (
          <PipelineRow key={s.name} step={s} offset={i * 1.0} />
        ))}
      </div>
    </section>
  );
}

/* ============================================================
   Dispatcher
   ============================================================ */

const BANDS = {
  ascii:    { component: () => <ASCIIBand />,  label: "01 · ASCII (default)" },
  ticker:   { component: BandTicker,           label: "02 · Ticker" },
  graph:    { component: BandGraph,            label: "03 · Graph" },
  monitor:  { component: BandMonitor,          label: "04 · Monitor" },
  kinetic:  { component: BandKinetic,          label: "05 · Kinetic" },
  pipeline: { component: BandPipeline,         label: "06 · Pipeline" },
};

function Band({ variant }) {
  const entry = BANDS[variant] || BANDS.ascii;
  const C = entry.component;
  return <C />;
}

Object.assign(window, {
  BandTicker, BandGraph, BandMonitor, BandKinetic, BandPipeline,
  Band, BANDS,
});
