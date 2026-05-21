// ────────────────────────────────────────────────────────────────
// 23 — Lifecycle (5 hooks)
//
//   nav
//   ┌──────────────┬──────────────────────────────┬──────────────┐
//   │ concept nav  │   H1 · lede                  │  on-this-page│
//   │ (Lifecycle   │   ── 5-hook horizontal seq   │  TOC         │
//   │  active)     │   ── interactive state       │              │
//   │              │      machine + scrubber      │              │
//   │              │   ── hook semantics          │              │
//   │              │   ── failure ordering        │              │
//   │              │   ── idempotency rules       │              │
//   │              │   ── "read next →"           │              │
//   └──────────────┴──────────────────────────────┴──────────────┘
//   StatusBar · ASCII band (class D — booting Pip DAG)
//
// LAW-CHUNKING   — 5 hooks · 7 scrubbable states · 3 rule blocks
// LAW-LABOR-ILLUSION — scrubber makes the contract visible
// LAW-PEAK-END   — state machine = peak. "Read next →" = end.
// ────────────────────────────────────────────────────────────────

const { useState: useStateLc, useEffect: useEffectLc, useRef: useRefLc } = React;

/* ── the 7 scrubber positions ──────────────────────────── */
const SM_STATES = [
  {
    key: "defined",
    label: "defined",
    glyph: "○",
    kicker: "state · 0 / 7",
    title: "defined",
    body: (
      <>
        Just <span className="fg">defineApp()</span>'d. The Pip graph is
        resolved &mdash; topo order known &mdash; but no hook has fired.
        Calling <span className="fg">.boot()</span> from here runs
        <span className="fg"> configure → boot</span> end-to-end.
      </>
    ),
    fact: { hook: "—", io: "none", pip: "frozen" },
    factTone: "idle",
  },
  {
    key: "configured",
    label: "configured",
    glyph: "●",
    kicker: "state · 1 / 7",
    title: "configured",
    body: (
      <>
        Every Pip's <span className="fg">configure(ctx)</span> ran in
        topo order. Env validated; types registered. <span className="fg">No
        I/O has touched the network or disk yet.</span>
      </>
    ),
    fact: { hook: "configure", io: "denied", pip: "all green" },
    factTone: "ok",
  },
  {
    key: "booted",
    label: "booted",
    glyph: "●",
    kicker: "state · 2 / 7",
    title: "booted",
    body: (
      <>
        Every Pip's <span className="fg">boot(ctx)</span> resolved.
        Connections open, migrations idempotent, caches warm. The app is
        ready to accept traffic but <span className="fg">isn't accepting
        yet</span>. <code>.boot()</code> is idempotent past this state.
      </>
    ),
    fact: { hook: "boot", io: "open", pip: "all booted" },
    factTone: "ok",
  },
  {
    key: "started",
    label: "started",
    glyph: "●",
    kicker: "state · 3 / 7",
    title: "started",
    body: (
      <>
        HTTP listeners bound. Queue workers polling. Schedulers ticking.
        The app is <span className="fg">accepting traffic</span>. This is
        the only state where <code>process.exit()</code> would drop
        requests &mdash; SIGTERM lands here.
      </>
    ),
    fact: { hook: "start", io: "active", pip: "serving" },
    factTone: "active",
  },
  {
    key: "stopped",
    label: "stopped",
    glyph: "●",
    kicker: "state · 4 / 7",
    title: "stopped",
    body: (
      <>
        New traffic refused; in-flight work drained. Connections still
        open. <span className="fg">.start() from here restarts traffic
        </span> without re-booting &mdash; the loop on the right of the
        diagram.
      </>
    ),
    fact: { hook: "stop", io: "draining", pip: "quiesced" },
    factTone: "active",
  },
  {
    key: "disposed",
    label: "disposed",
    glyph: "●",
    kicker: "state · 5 / 7",
    title: "disposed",
    body: (
      <>
        Teardown ran in <span className="fg">reverse topo order</span>.
        Connections closed, logs flushed, file handles released. The Pip
        graph is unrecoverable from this state &mdash; you must
        <code> defineApp()</code> again.
      </>
    ),
    fact: { hook: "dispose", io: "closed", pip: "released" },
    factTone: "idle",
  },
  {
    key: "failed",
    label: "failed",
    glyph: "✕",
    kicker: "state · 6 / 7",
    title: "failed",
    body: (
      <>
        <span className="fg">boot()</span> threw on
        <code> @arki/db</code>. The framework called
        <code> dispose()</code> on every Pip that already booted, in
        reverse order. A structured envelope hit stderr; the exit code is
        stable.
      </>
    ),
    fact: { hook: "boot ✕", io: "rolled back", pip: "DB_CONNECT_REFUSED" },
    factTone: "fail",
  },
];

/* helper — classify a node for a given current-state index */
function cls(state, nodeIndex, nodeIsFail = false) {
  // nodeIndex matches state order: defined(0), configured(1), booted(2),
  // started(3), stopped(4), disposed(5). The 'failed' node only renders
  // in state 6.
  if (state === 6) {
    if (nodeIsFail) return "active";
    if (nodeIndex < 2) return "done";
    if (nodeIndex === 2) return "fail"; // booted is the throw-site
    return "pending";
  }
  if (nodeIndex < state) return "done";
  if (nodeIndex === state) return "active";
  return "pending";
}
function edgeCls(state, fromIdx, toIdx, isFailEdge = false) {
  if (state === 6) {
    if (isFailEdge) return "lit";   // fail edge to "failed"
    if (toIdx <= 1) return "lit";    // defined→configured
    return "edge";
  }
  // light edge if both endpoints are already done (or to-active = currently transitioning)
  if (state >= toIdx) return "lit";
  return "edge";
}

/* ── the ASCII state-machine, parameterised by state idx ── */
function StateMachineASCII({ state }) {
  // Helper renderers
  const N = (i, txt) => <span className={"node " + cls(state, i)}>{txt}</span>;
  const Nf = (txt) => <span className={"node " + cls(state, 0, true)}>{txt}</span>;
  const L = (i, txt) => <span className={"lbl " + cls(state, i)}>{txt}</span>;
  const Lf = (txt) => <span className={"lbl " + cls(state, 0, true)}>{txt}</span>;
  const E = (from, to, txt) => <span className={"edge " + edgeCls(state, from, to)}>{txt}</span>;
  const Ef = (txt) => <span className={"edge " + (state === 6 ? "lit fail" : "edge")}>{txt}</span>;
  // Right-loop edge: lit when stopped→started transition possible (state ≥ 4)
  const ER = (txt) => <span className={"edge " + ((state >= 3 && state <= 5) ? "lit" : "edge")}>{txt}</span>;

  return (
    <pre className="lc-ascii" aria-hidden="true">
{`           `}{N(0,"┌─────────┐")}{`\n`}
{`           `}{N(0,"│ defined │")}{`                                  `}{N(6,"┌────────┐")}{`\n`}
{`           `}{N(0,"└────┬────┘")}{`                                  `}{Nf("│ failed │")}{`\n`}
{`                `}{E(0,1,"▼")}{`  `}{L(1,"configure()")}{`                       `}{N(6,"└────────┘")}{`\n`}
{`         `}{N(1,"┌────────────┐")}{`                                  `}{`     ▲    `}{`\n`}
{`         `}{N(1,"│ configured │")}{`                                  `}{`     │    `}{`\n`}
{`         `}{N(1,"└─────┬──────┘")}{`                                  `}{`     │    `}{`\n`}
{`               `}{E(1,2,"▼")}{`  `}{L(2,"boot()")}{`        `}{Ef("──── throw ────────┘")}{`     `}{`\n`}
{`           `}{N(2,"┌────────┐")}{`        `}{Ef("│")}{`                              `}{`\n`}
{`           `}{N(2,"│ booted │")}{`────────`}{Ef("┘ ")}{Lf("boot()/start() fail")}{`             `}{`\n`}
{`           `}{N(2,"└───┬────┘")}{`                                       `}{`\n`}
{`               `}{E(2,3,"▼")}{`  `}{L(3,"start()")}{`                                  `}{`\n`}
{`           `}{N(3,"┌─────────┐")}{`         `}{ER("┌──")}{` `}<span className={"lbl " + ((state >= 3 && state <= 5) ? "lit" : "")}>{"start()"}</span>{`              `}{`\n`}
{`           `}{N(3,"│ started │ ")}{ER("◄──────┤")}{`                              `}{`\n`}
{`           `}{N(3,"└────┬────┘")}{`         `}{ER("│")}{`                              `}{`\n`}
{`               `}{E(3,4,"▼")}{`  `}{L(4,"stop()")}{`     `}{ER("│")}{`                              `}{`\n`}
{`           `}{N(4,"┌─────────┐")}{`         `}{ER("│")}{`                              `}{`\n`}
{`           `}{N(4,"│ stopped │")}{`─────────`}{ER("┘")}{`                              `}{`\n`}
{`           `}{N(4,"└────┬────┘")}{`                                       `}{`\n`}
{`               `}{E(4,5,"▼")}{`  `}{L(5,"dispose()")}{`                                `}{`\n`}
{`          `}{N(5,"┌──────────┐")}{`                                       `}{`\n`}
{`          `}{N(5,"│ disposed │")}{`                                       `}{`\n`}
{`          `}{N(5,"└──────────┘")}{`                                       `}{`\n`}
    </pre>
  );
}

/* ── the figure (header + diagram + callout + scrubber) ── */
function StateMachine() {
  const [state, setState] = useStateLc(2); // default land on "booted"
  const sliderRef = useRefLc(null);

  // keyboard ←/→ when slider focused — native <input type="range">
  // already handles this, so we just wire focus styling.

  const cur = SM_STATES[state];
  const captionText = (() => {
    if (state === 6) {
      return "boot() threw on @arki/db. The framework rolled back every booted Pip in reverse topo order. The app is in the terminal 'failed' state — no further hooks will fire.";
    }
    const path = SM_STATES.slice(0, state + 1).map(s => s.label).join(" → ");
    return `Lifecycle position: ${path}.`;
  })();

  return (
    <figure className="lc-figure" aria-labelledby="sm-h">
      <div className="lc-fig-head">
        <div className="lhs">
          <span className="lbl">FIG&nbsp;C1</span>
          <span className="sep">·</span>
          <span>lifecycle state machine</span>
          <span className="sep">·</span>
          <span>7 states</span>
        </div>
        <div className="rhs">
          <span className={
            "pill-mono " +
            (state === 6 ? "fail" :
             state === 5 ? "idle" :
             state === 3 ? "active" : "ok")
          }>
            <i className={
              "ph " + (state === 6 ? "ph-x-circle" : "ph-circle-fill")
            } aria-hidden="true"></i>
            {cur.label}
          </span>
        </div>
      </div>

      <div className="lc-sm">
        <div className="lc-sm-diagram">
          <StateMachineASCII state={state} />
        </div>

        <aside className="lc-sm-callout" aria-live="polite">
          <div className="co-kicker">{cur.kicker}</div>
          <div className="co-state">
            <span className="ph">{cur.glyph}</span>
            <span>{cur.title}</span>
          </div>
          <p>{cur.body}</p>
          <div className="co-fact">
            <span><span className="k">hook&nbsp;&nbsp;</span>
              <span className={"v " + (state === 6 ? "bad" : "")}>{cur.fact.hook}</span>
            </span>
            <span><span className="k">i/o&nbsp;&nbsp;&nbsp;</span>
              <span className={"v " + (state === 6 ? "warn" : "")}>{cur.fact.io}</span>
            </span>
            <span><span className="k">pip&nbsp;&nbsp;&nbsp;</span>
              <span className={"v " + (state === 6 ? "bad" : (state === 1 || state === 2 ? "ok" : ""))}>{cur.fact.pip}</span>
            </span>
          </div>
        </aside>
      </div>

      <div className="lc-scrub">
        <span className="scrub-lbl" id="scrub-h">scrub state</span>

        <div className="scrub-rail">
          <div className="scrub-glyphs" aria-hidden="true">
            {SM_STATES.map((s, i) => {
              const isFail = i === 6;
              const k =
                i === state ? (isFail ? "fail" : "active") :
                (!isFail && i < state) ? "done" : "";
              return <span key={s.key} className={k}>{i === state ? (isFail ? "✕" : "●") : (!isFail && i < state) ? "●" : "○"}</span>;
            })}
          </div>
          <input
            ref={sliderRef}
            type="range"
            min={0} max={6} step={1}
            value={state}
            aria-labelledby="scrub-h"
            aria-valuemin={0}
            aria-valuemax={6}
            aria-valuenow={state}
            aria-valuetext={cur.label}
            onChange={(e) => setState(parseInt(e.target.value, 10))}
          />
          <div className="scrub-ticks" aria-hidden="true">
            {SM_STATES.map((s, i) => (
              <span key={s.key}
                    className={
                      i === state ? (i === 6 ? "fail" : "active") : ""
                    }>
                {s.label}
              </span>
            ))}
          </div>
        </div>

        <div className="scrub-keys">
          <span className="kbd">←</span>&nbsp;<span className="kbd">→</span>
        </div>
      </div>
    </figure>
  );
}

/* ── 5-hook horizontal sequence ────────────────────────── */
function HookSequence() {
  const hooks = [
    { n: "configure", k: "sync",  c: "no I/O" },
    { n: "boot",      k: "async", c: "I/O ok" },
    { n: "start",     k: "async", c: "accept" },
    { n: "stop",      k: "async", c: "drain"  },
    { n: "dispose",   k: "async", c: "release"},
  ];
  return (
    <div className="lc-hook-seq" role="img"
         aria-label="The 5 hooks fire in order: configure (sync), then boot, start, stop, dispose (all async).">
      <div className="row">
        {hooks.map((h, i) => (
          <React.Fragment key={h.n}>
            <div className="hk">
              <div className="hk-box">{h.n}</div>
              <div className={"hk-meta " + h.k}>{h.k}</div>
              <div className="hk-meta">{h.c}</div>
            </div>
            {i < hooks.length - 1 && <div className="arr">▸</div>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ── annotated rule block (A4 callouts) ────────────────── */
function RuleBlock({ title, rules }) {
  return (
    <div className="lc-rules">
      <div className="head">
        <span>{title}</span>
        <span>contract</span>
      </div>
      <div className="body">
        {rules.map((r, i) => (
          <React.Fragment key={i}>
            <div className="rule">
              <span dangerouslySetInnerHTML={{ __html: r.code }} />
            </div>
            <div className="a4">{r.a4}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ── concept sidebar ───────────────────────────────────── */
function ConceptSide() {
  const items = [
    { g: "Getting started" },
    { ord: "10", label: "Install" },
    { ord: "12", label: "First app" },
    { ord: "13", label: "First run" },
    { g: "Concepts" },
    { ord: "21", label: "defineApp" },
    { ord: "22", label: "Pip contract" },
    { ord: "23", label: "Lifecycle", active: true },
    { ord: "24", label: "Manifest & diagnostics" },
    { ord: "25", label: "Adapters" },
    { ord: "26", label: "Context & services" },
    { ord: "27", label: "Testing harness" },
    { g: "API" },
    { ord: "61", label: "defineApp" },
    { ord: "62", label: "Pip types" },
    { ord: "63", label: "Manifest types" },
  ];
  return (
    <aside className="lc-side" aria-label="Concept navigation">
      {items.map((it, i) =>
        it.g ? (
          <div className="group" key={"g" + i}>{it.g}</div>
        ) : (
          <a key={it.ord} href="#"
             className={it.active ? "active" : ""}
             aria-current={it.active ? "page" : undefined}>
            <span className="ord">{it.ord}</span>
            <span>{it.label}</span>
          </a>
        )
      )}
    </aside>
  );
}

/* ── right-rail TOC ────────────────────────────────────── */
function ConceptToc() {
  return (
    <aside className="lc-toc" aria-label="On this page">
      <div className="ttl">on this page</div>
      <a href="#hooks">The 5 hooks</a>
      <a href="#machine" className="active">State machine</a>
      <a href="#fire">When does each fire?</a>
      <a href="#failure">Failure ordering</a>
      <a href="#idempotency">Idempotency rules</a>
      <a href="#" style={{ marginTop: 12, color: "var(--accent)" }}>
        edit on github ↗
      </a>
    </aside>
  );
}

/* ── the screen ────────────────────────────────────────── */
function Lifecycle() {
  return (
    <main className="container" id="main">
      <div className="lc-grid">
        <ConceptSide />

        <article className="lc-main">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <a href="#">Docs</a>
            <span className="sep">/</span>
            <a href="#">Concepts</a>
            <span className="sep">/</span>
            <span className="here">Lifecycle</span>
          </nav>

          <h1>Lifecycle <span className="dot">(</span>5 hooks<span className="dot">)</span></h1>

          <p className="lede">
            Every DOT app runs through five hooks per Pip, in topological
            order: <span className="fg"><code>configure</code> → <code>boot</code> → <code>start</code> → <code>stop</code> → <code>dispose</code></span>.
            The order is fixed, the work inside it is yours, and every state
            transition is observable from <code>dot doctor --json</code>.
          </p>

          <h2 id="hooks">
            <span>The 5 hooks</span>
            <span className="anchor">#hooks</span>
          </h2>
          <HookSequence />

          <h2 id="machine">
            <span>State machine</span>
            <span className="anchor">#machine</span>
          </h2>
          <p className="muted">
            Drag the scrubber, or focus it and use <code>←</code> / <code>→</code>.
            Each position is a real state &mdash; nothing is animated for show.
          </p>
          <StateMachine />
          <figcaption className="lc-figcap">
            <span className="k">FIG&nbsp;C1</span>
            <span>
              Seven lifecycle positions: <span style={{color:"var(--foreground)"}}>defined → configured → booted → started → stopped → disposed</span>,
              and the terminal <span style={{color:"hsl(0 63% 60%)"}}>failed</span> branch reachable from boot or start.
              Reverse-topo teardown is implied at every backward arrow.
            </span>
          </figcaption>

          <h2 id="fire">
            <span>When does each hook fire?</span>
            <span className="anchor">#fire</span>
          </h2>
          <p>
            Each hook fires once per Pip per app instance. Within a hook, Pips
            run in <em>topological</em> order &mdash; a Pip that <code>.use()</code>'d
            another is guaranteed to see the dependency already-hooked.
          </p>
          <RuleBlock
            title="hook-firing.ts"
            rules={[
              { code: '<span class="kw">configure</span>(<span class="var">ctx</span>)  <span class="com">// sync. env, types, schema. no I/O.</span>',          a4: "A4 · before any side-effects" },
              { code: '<span class="kw">boot</span>(<span class="var">ctx</span>)       <span class="com">// async. open connections, migrate.</span>',         a4: "A4 · idempotent past booted" },
              { code: '<span class="kw">start</span>(<span class="var">ctx</span>)      <span class="com">// async. listeners, workers, sched.</span>',         a4: "A4 · the only accepting state" },
              { code: '<span class="kw">stop</span>(<span class="var">ctx</span>)       <span class="com">// async. drain, refuse new traffic.</span>',         a4: "A4 · SIGTERM lands here" },
              { code: '<span class="kw">dispose</span>(<span class="var">ctx</span>)    <span class="com">// async. close handles. reverse-topo.</span>',       a4: "A4 · last opened, first closed" },
            ]}
          />

          <h2 id="failure">
            <span>Failure ordering</span>
            <span className="anchor">#failure</span>
          </h2>
          <p>
            A hook that throws is a state transition, not a panic. The
            framework reverses what it just did and exits with a stable code.
            <code> dot doctor --json</code> returns the same envelope a
            running supervisor would log.
          </p>
          <ul>
            <li><code>configure</code> fails &mdash; lifecycle stops. No cleanup needed.</li>
            <li><code>boot</code> fails &mdash; dispose every already-booted Pip in <em>reverse</em> topological order.</li>
            <li><code>start</code> fails &mdash; stop and dispose every Pip that started or booted.</li>
            <li><code>stop</code> / <code>dispose</code> &mdash; continue through cleanup after individual hook failures. Errors collect into a single envelope.</li>
          </ul>

          <h2 id="idempotency">
            <span>Idempotency rules</span>
            <span className="anchor">#idempotency</span>
          </h2>
          <p>
            Calling a hook from the wrong state is a no-op, not an error. The
            framework decides what to skip and what to forward. The rules
            below are exhaustive.
          </p>
          <RuleBlock
            title="idempotency.ts"
            rules={[
              { code: '<span class="var">app</span>.<span class="fn">boot</span>()      <span class="com">// no-op if {booted, started, stopped}</span>',       a4: "A4 · safe to call from anywhere" },
              { code: '<span class="var">app</span>.<span class="fn">start</span>()     <span class="com">// boots first if not yet booted</span>',           a4: "A4 · forwarding allowed" },
              { code: '<span class="var">app</span>.<span class="fn">stop</span>()      <span class="com">// only runs on currently-started Pips</span>',    a4: "A4 · per-Pip dispatch" },
              { code: '<span class="var">app</span>.<span class="fn">dispose</span>()   <span class="com">// implies stop() first if started</span>',         a4: "A4 · terminal — graph released" },
            ]}
          />

          <a className="lc-next" href="#">
            <div className="l">
              <span className="k">read next →</span>
              <span className="t">Manifest &amp; diagnostics</span>
              <span className="s">/docs/concepts/manifest-diagnostics &nbsp;·&nbsp; 24</span>
            </div>
            <span className="arr">→</span>
          </a>
        </article>

        <ConceptToc />
      </div>
    </main>
  );
}

Object.assign(window, { Lifecycle });
