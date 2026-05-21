// Shared chrome: Nav, StatusBar, ASCIIBand
const { useState, useEffect, useRef } = React;

function Nav({ route, setRoute, theme, setTheme }) {
  const links = [
    { id: "docs",   label: "Docs",      to: "concept" },
    { id: "pkgs",   label: "Packages",  to: "packages" },
    { id: "cli",    label: "CLI",       to: "cli" },
    { id: "agents", label: "Agents",    to: "agents" },
    { id: "why",    label: "Why",       to: "philosophy" },
  ];
  return (
    <nav className="nav" aria-label="Primary">
      <div className="nav-left">
        <a href="#" className="nav-mark" onClick={(e) => { e.preventDefault(); setRoute("home"); }}>
          arki<span className="accent">.</span><span className="dim">dot</span>
        </a>
        <div style={{display:"flex", gap: 4}}>
          {links.map(l => (
            <a key={l.id}
               className={"nav-link" + (route === l.to ? " active" : "")}
               href="#"
               onClick={(e) => { e.preventDefault(); setRoute(l.to); }}>
              {l.label}
            </a>
          ))}
        </div>
      </div>
      <div className="nav-right">
        <div className="cmdk">
          <i className="ph ph-magnifying-glass" style={{fontSize: 14}}></i>
          <span>Search docs, packages…</span>
          <span className="kbd">⌘K</span>
        </div>
        <button className="icon-btn"
                aria-label="Toggle theme"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          <i className={"ph " + (theme === "dark" ? "ph-sun" : "ph-moon")}></i>
        </button>
        <a className="icon-btn" aria-label="GitHub" href="#"><i className="ph ph-github-logo"></i></a>
      </div>
    </nav>
  );
}

function StatusBar({ route }) {
  return (
    <div className="statusbar" role="contentinfo">
      <div className="grp">
        <span>v0.1.0</span><span className="sep">·</span>
        <span>802cf4e</span><span className="sep">·</span>
        <span>MIT</span><span className="sep">·</span>
        <span className="pill success" style={{height:18, padding:"0 8px", fontSize:10}}>
          <span className="dot"></span>all green
        </span>
      </div>
      <div className="grp">
        <a href="#">⌘K search</a>
        <span className="sep">·</span>
        <a href="#">⌘/ theme</a>
        <span className="sep">·</span>
        <a href="#">llms.txt</a>
        <span className="sep">·</span>
        <a href="#">changelog</a>
        <span className="sep">·</span>
        <a href="#">github</a>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
   Retro CRT wordmark — "arki.dot" in VT323 at a huge size.
   The bitmap glow on the amber period reads like a phosphor pixel.
   -------------------------------------------------------------- */
function RetroMark() {
  return (
    <div aria-hidden="true">
      <div className="vt-mark">
        arki<span className="accent">.</span>dot
      </div>
      <div className="vt-sub">
        <span className="a">&gt;</span> ship faster<span className="caret"></span>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
   Lifecycle conveyor — five nodes, one lit at a time, in order.
   "configure ▸ boot ▸ start ▸ stop ▸ dispose"
   -------------------------------------------------------------- */
function Conveyor() {
  const [lit, setLit] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setLit((x) => (x + 1) % 5), 1100);
    return () => clearInterval(id);
  }, []);
  const labels = ["configure", "boot", "start", "stop", "dispose"];
  return (
    <div className="conveyor" aria-hidden="true">
      <div className="track">
        {labels.map((_, i) => (
          <React.Fragment key={i}>
            <span className={"node" + (i === lit ? " lit" : "")}>{i === lit ? "●" : "○"}</span>
            {i < 4 && <span className="edge"></span>}
          </React.Fragment>
        ))}
      </div>
      <div className="labels">
        {labels.map((l) => <span key={l}>{l}</span>)}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------
   Animated terminal — cycles three scripted scenes, typewriter.
   Each scene is a list of lines; each line types in then pauses.
   -------------------------------------------------------------- */
const TERM_SCENES = [
  [
    { t: "cmd",  text: "bun add @arki/dot" },
    { t: "ok",   text: "✓ resolved 7 packages" },
    { t: "ok",   text: "✓ @arki/dot       v0.1.0  9.2 KB" },
    { t: "ok",   text: "✓ @arki/db        v0.1.0  14.4 KB" },
    { t: "ok",   text: "✓ @arki/queue     v0.1.0  9.7 KB" },
  ],
  [
    { t: "cmd",  text: "dot doctor" },
    { t: "boot", text: "→ configure  ✓ db  ✓ kv  ✓ queue" },
    { t: "boot", text: "→ boot       ✓ db  ✓ kv  ✓ queue" },
    { t: "boot", text: "→ start      ✓ http :3000  ✓ workers" },
    { t: "ok",   text: "✓ all plugins green" },
  ],
  [
    { t: "cmd",  text: "dot doctor --json | jq .ok" },
    { t: "boot", text: "true" },
    { t: "cmd",  text: "dot explain --graph" },
    { t: "boot", text: "@arki/dot ──┬── @arki/env" },
    { t: "boot", text: "            ├── @arki/db" },
    { t: "boot", text: "            └── @arki/queue" },
  ],
];

function Terminal() {
  const [scene, setScene] = useState(0);
  const [shown, setShown] = useState([]);   // array of fully-typed line indices
  const [typing, setTyping] = useState(""); // current partial line

  useEffect(() => {
    let cancelled = false;
    const lines = TERM_SCENES[scene];
    let lineIdx = 0;
    let charIdx = 0;
    setShown([]);
    setTyping("");

    function step() {
      if (cancelled) return;
      const line = lines[lineIdx];
      if (!line) {
        // scene done — hold then move on
        setTimeout(() => { if (!cancelled) setScene((s) => (s + 1) % TERM_SCENES.length); }, 1800);
        return;
      }
      if (charIdx <= line.text.length) {
        setTyping(line.text.slice(0, charIdx));
        charIdx++;
        const speed = line.t === "cmd" ? 38 : 14;
        setTimeout(step, speed);
      } else {
        // commit the line
        setShown((s) => [...s, lineIdx]);
        setTyping("");
        lineIdx++;
        charIdx = 0;
        const pause = line.t === "cmd" ? 320 : 90;
        setTimeout(step, pause);
      }
    }
    const tid = setTimeout(step, 220);
    return () => { cancelled = true; clearTimeout(tid); };
  }, [scene]);

  const lines = TERM_SCENES[scene];
  const visibleCount = shown.length;

  return (
    <div className="term" aria-hidden="true">
      {lines.slice(0, visibleCount).map((l, i) => (
        <div key={i} className={"line " + l.t}>
          {l.t === "cmd"  && <span className="p">$ </span>}
          {l.t === "ok"   && <span className="mark">✓ </span>}
          {l.t === "warn" && <span className="mark">◐ </span>}
          {l.text}
        </div>
      ))}
      {visibleCount < lines.length && (
        <div className={"line " + lines[visibleCount].t}>
          {lines[visibleCount].t === "cmd"  && <span className="p">$ </span>}
          {lines[visibleCount].t === "ok"   && <span className="mark">✓ </span>}
          {lines[visibleCount].t === "warn" && <span className="mark">◐ </span>}
          {typing}
          <span className="caret"></span>
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------
   Background code rain — columns of falling characters.
   Subtle (low opacity, behind everything).
   -------------------------------------------------------------- */
const RAIN_CHARS = "{}[]()<>;:,.=+-*/|\\\"'`~!@#$%^&?abcdefghijklmnopqrstuvwxyz0123456789_";
function makeRainCol(len) {
  let s = "";
  for (let i = 0; i < len; i++) s += RAIN_CHARS[(Math.random() * RAIN_CHARS.length) | 0];
  return s;
}
function CodeRain() {
  // 60 columns, each gets a different random delay + duration
  const cols = React.useMemo(() => {
    const arr = [];
    for (let i = 0; i < 60; i++) {
      arr.push({
        text: makeRainCol(40),
        dur:  (6 + Math.random() * 10).toFixed(2) + "s",
        del:  (-Math.random() * 12).toFixed(2) + "s",
      });
    }
    return arr;
  }, []);
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

function ASCIIBand() {
  return (
    <>
      <section className="ascii-band" aria-hidden="true">
        <CodeRain />
        <div className="grid">
          <RetroMark />
          <Conveyor />
          <Terminal />
        </div>
      </section>
      <span className="sr-only">
        ASCII brand band. arki.dot wordmark, plugin lifecycle conveyor
        (configure, boot, start, stop, dispose), and an animated terminal
        cycling through canonical commands: bun add @arki/dot, dot doctor,
        dot explain --graph.
      </span>
    </>
  );
}

Object.assign(window, { Nav, StatusBar, ASCIIBand });
