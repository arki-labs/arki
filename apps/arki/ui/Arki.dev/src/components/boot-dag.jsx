// ────────────────────────────────────────────────────────────────
// Class D — "booting plugin DAG"
//
// Full-bleed band that lives below the page status bar (00-home spec).
// Plugin nodes light up in topo order, terminating at a "booted ✓"
// box. Loop ≤ 8s; freezes at end frame under prefers-reduced-motion.
//
// Implementation: flex layout of glyph-bordered cells, NOT a literal
// ASCII art string — that lines up reliably across font/zoom changes.
// ────────────────────────────────────────────────────────────────

const { useState: useS, useEffect: useE, useMemo: useM } = React;

// Topo order:
//   env, log  →  db  →  kv  →  auth  →  queue  →  booted ✓
// Two parallel inputs (env, log) feed into db, then a linear chain.
const DAG_STAGES = [
  { id: "env",    label: "env",     col: "in"     },
  { id: "log",    label: "log",     col: "in"     },
  { id: "db",     label: "db",      col: "chain"  },
  { id: "kv",     label: "kv",      col: "chain"  },
  { id: "auth",   label: "auth",    col: "chain"  },
  { id: "queue",  label: "queue",   col: "chain"  },
];
const TOTAL_STAGES = DAG_STAGES.length; // last index after this = booted ✓

function useTopoLight({ count, tickMs = 850, holdEndMs = 1800 }) {
  const [i, set] = useS(0);
  useE(() => {
    let cancelled = false;
    function step(idx) {
      if (cancelled) return;
      set(idx);
      const next = idx + 1;
      if (next > count) {
        setTimeout(() => step(0), holdEndMs);
      } else {
        setTimeout(() => step(next), tickMs);
      }
    }
    const t = setTimeout(() => step(0), 220);
    return () => { cancelled = true; clearTimeout(t); };
  }, [count, tickMs, holdEndMs]);
  return i;
}

// — code rain layer —
const RAIN_CHARS = "{}[]()<>;:,.=+-*/|\\\"'`~!@#$%^&?abcdefghijklmnopqrstuvwxyz0123456789_";
function makeRainCol(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += RAIN_CHARS[(Math.random() * RAIN_CHARS.length) | 0];
  return s;
}
function CodeRain({ density = 70 }) {
  const cols = useM(() => {
    const arr = [];
    for (let i = 0; i < density; i++) {
      arr.push({
        text: makeRainCol(36),
        dur:  (7 + Math.random() * 11).toFixed(2) + "s",
        del:  (-Math.random() * 14).toFixed(2) + "s",
      });
    }
    return arr;
  }, [density]);
  return (
    <div className="rain" aria-hidden="true">
      {cols.map((c, i) => (
        <div key={i} className="col" style={{ animationDuration: c.dur, animationDelay: c.del }}>
          {c.text}
        </div>
      ))}
    </div>
  );
}

// — node cell: │ label │ with top/bottom borders, lit by topo idx —
function Node({ label, idx, lit, kind = "node" }) {
  const state =
    lit === idx ? "active" :
    lit  >  idx ? "done"   :
    "pending";
  return (
    <div className={"bd-node bd-node-" + kind + " bd-state-" + state}>
      <div className="bd-node-top">┌{"─".repeat(label.length + 2)}┐</div>
      <div className="bd-node-mid">│ <span className="bd-node-lbl">{label}</span> │</div>
      <div className="bd-node-bot">└{"─".repeat(label.length + 2)}┘</div>
    </div>
  );
}

// — connector: variable width, optional arrowhead, lit when target stage active —
function Arrow({ litFrom, litTo, lit, width = 28, head = true }) {
  const isLit = lit >= litTo; // edge is lit once the *destination* has fired
  return (
    <div className={"bd-arrow" + (isLit ? " bd-arrow-lit" : "")}>
      <div className="bd-arrow-line" style={{ width }}>
        {"─".repeat(Math.max(2, Math.floor(width / 7)))}
        {head ? "▶" : ""}
      </div>
    </div>
  );
}

// — the band ──────────────────────────────────────────────────
function BandBootDag({ tickMs = 850 }) {
  const lit = useTopoLight({ count: TOTAL_STAGES, tickMs });
  const booted = lit === TOTAL_STAGES;

  return (
    <section className="band band-boot" role="img"
             aria-label="Plugin lifecycle conveyor — env, log, db, kv, auth, queue boot in topological order.">
      <CodeRain density={70} />

      <div className="boot-inner">
        {/* meta */}
        <aside className="boot-side">
          <div className="band-tag">dag</div>
          <div className="band-title">booting</div>
          <div className="band-sub">dot explain --graph</div>
          <div className="boot-status">
            <span className={"boot-dot" + (booted ? " ok" : " run")}>
              {booted ? "●" : "◐"}
            </span>
            <span className="boot-status-label">
              {booted ? "booted" : `${Math.min(lit + 1, TOTAL_STAGES)} / ${TOTAL_STAGES}`}
            </span>
          </div>
        </aside>

        {/* stage */}
        <div className="boot-stage" aria-hidden="true">
          {/* left column: env / log inputs */}
          <div className="bd-col-in">
            <Node label="env" idx={0} lit={lit} />
            <Node label="log" idx={1} lit={lit} />
          </div>

          {/* fan-in junction */}
          <div className="bd-fanin">
            <div className="bd-fanin-top">─┐</div>
            <div className="bd-fanin-mid">─┤</div>
            <div className="bd-fanin-bot">─┘</div>
          </div>

          <Arrow litTo={2} lit={lit} width={22} />
          <Node label="db" idx={2} lit={lit} />
          <Arrow litTo={3} lit={lit} width={22} />
          <Node label="kv" idx={3} lit={lit} />
          <Arrow litTo={4} lit={lit} width={22} />
          <Node label="auth" idx={4} lit={lit} />
          <Arrow litTo={5} lit={lit} width={22} />
          <Node label="queue" idx={5} lit={lit} />
          <Arrow litTo={TOTAL_STAGES} lit={lit} width={22} />
          <Node
            label={booted ? "booted ✓" : "booting…"}
            idx={TOTAL_STAGES}
            lit={lit}
            kind={booted ? "terminal-ok" : "terminal"}
          />
        </div>
      </div>
    </section>
  );
}

Object.assign(window, { BandBootDag });
