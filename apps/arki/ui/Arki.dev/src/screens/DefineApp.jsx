// ────────────────────────────────────────────────────────────────
// 21 — defineApp (concept page · the framework's #3 priority)
//
//   ┌──────────────┬─────────────────────────────────┬──────────────┐
//   │ concept nav  │ H1 · lede · signature           │ on-this-page │
//   │ (defineApp   │ ── A1 LIVE PLAYGROUND ──        │ TOC          │
//   │  active)     │   tabs: Code / Types / Diag     │              │
//   │              │   edit → infer → diagnose       │              │
//   │              │ ── Type inference (A4)          │              │
//   │              │ ── What .boot() does (steps)    │              │
//   │              │ ── Common mistakes (✗ / ✓)      │              │
//   │              │ ── Read next →                  │              │
//   └──────────────┴─────────────────────────────────┴──────────────┘
//   StatusBar · ASCII band (class A — lifecycle conveyor)
//
// LAW-LABOR-ILLUSION — playground makes inference visible
// LAW-PEAK-END       — playground is the peak; "Read next" is the end
// LAW-RECIPROCITY    — free, instant, working example (no signup)
// ────────────────────────────────────────────────────────────────

const { useState: useStateDa, useEffect: useEffectDa, useMemo: useMemoDa, useRef: useRefDa } = React;

/* ── plugin registry — drives type inference & diagnostics ── */
const PIP_REGISTRY = {
  env:    { service: "env",    type: "EnvService",    dts: "{ get<T>(k: string): T; require(k: string): string }" },
  db:     { service: "db",     type: "DbClient",      dts: "{ query<T>(sql: string, ...): Promise<T[]>; pool: Pool }" },
  kv:     { service: "kv",     type: "KvStore",       dts: "{ get(k: string): Promise<string | null>; set(k: string, v: string): Promise<void> }" },
  queue:  { service: "queue",  type: "QueueClient",   dts: "{ enqueue(name: string, payload: unknown): Promise<JobId> }" },
  http:   { service: "http",   type: "HttpServer",    dts: "{ get(path, h): void; post(path, h): void; listen(port): Promise<void> }" },
  auth:   { service: "auth",   type: "AuthService",   dts: "{ sign(payload): string; verify(token): Claims }" },
  logger: { service: "logger", type: "Logger",        dts: "{ info(msg, meta?): void; warn(msg, meta?): void; error(msg, meta?): void }" },
  cache:  { service: "cache",  type: "Cache",         dts: "{ get<T>(k: string): Promise<T | null>; ttl(k: string, ms: number): Promise<void> }" },
};

/* ── default playground source ─────────────────────────── */
const DEFAULT_SRC =
`import { defineApp } from "@arki/dot"
import { env }       from "@arki/env"
import { db }        from "@arki/db"
import { kv }        from "@arki/kv"

export const app = await defineApp("billing")
  .use(env())
  .use(db({ url: process.env.DATABASE_URL }))
  .use(kv())
  .boot()

// hover any line → see the inferred type`;

/* ── tiny syntax highlighter (single-pass tokenizer) ──────
   One regex with prioritised alternatives so injected markup
   is never re-scanned. Order matters: comments and strings
   must beat keywords/identifiers. */
const HL_RE = new RegExp(
  [
    "(\\/\\/[^\\n]*)",                                                                                  // 1: line comment
    "(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*')",                                            // 2: string
    "\\b(import|export|from|const|let|var|return|await|async|function|new|true|false|null|undefined|as|type|interface|extends)\\b", // 3: keyword
    "\\b(defineApp|use|boot|configure|start|stop|dispose)\\b",                                          // 4: known fn
    "\\b(app)\\b",                                                                                       // 5: app var
    "\\b(\\d+)\\b",                                                                                      // 6: number
  ].join("|"),
  "g"
);
function esc(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function highlight(src) {
  let out = "";
  let last = 0;
  let m;
  HL_RE.lastIndex = 0;
  while ((m = HL_RE.exec(src)) !== null) {
    if (m.index > last) out += esc(src.slice(last, m.index));
    const cls =
      m[1] ? "tk-com" :
      m[2] ? "tk-str" :
      m[3] ? "tk-kw"  :
      m[4] ? "tk-fn"  :
      m[5] ? "tk-var" :
      m[6] ? "tk-num" : null;
    out += `<span class="${cls}">${esc(m[0])}</span>`;
    last = m.index + m[0].length;
  }
  if (last < src.length) out += esc(src.slice(last));
  return out;
}

/* ── playground "compiler" — pure string scan, deterministic ── */
function compile(src) {
  const lines = src.split("\n");
  const diagnostics = [];
  let appName = null;
  let appNameLine = 0;
  let pips = []; // [{ name, line }]
  let usedAfterBoot = false;
  let bootLine = 0;
  let hasAwait = false;

  // Scan for defineApp("name")
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/defineApp\s*\(\s*["']([^"']+)["']/);
    if (m) {
      appName = m[1];
      appNameLine = i + 1;
      if (/await\s+defineApp/.test(ln)) hasAwait = true;
      break;
    }
  }

  // Scan for .use(<plugin>(...)
  let seenBoot = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.match(/\.boot\s*\(/)) {
      seenBoot = true;
      bootLine = i + 1;
      if (/\bawait\b/.test(ln)) hasAwait = true;
      // detect surrounding chain — look back a few lines too
    }
    const useMatches = [...ln.matchAll(/\.use\s*\(\s*(\w+)\s*\(/g)];
    for (const um of useMatches) {
      const name = um[1];
      pips.push({ name, line: i + 1, knownAfterBoot: seenBoot });
      if (seenBoot) usedAfterBoot = true;
    }
  }

  // Diagnostics
  if (!appName) {
    diagnostics.push({
      sev: "err", code: "E1001",
      msg: "defineApp must be called with a name argument",
      line: 1,
    });
  }
  if (!bootLine) {
    diagnostics.push({
      sev: "warn", code: "W2003",
      msg: "missing .boot() — app will never enter the booted state",
      line: appNameLine || 1,
    });
  } else if (!hasAwait) {
    diagnostics.push({
      sev: "warn", code: "W2001",
      msg: ".boot() returns a Promise — await it before exporting app",
      line: bootLine,
    });
  }
  if (usedAfterBoot) {
    diagnostics.push({
      sev: "err", code: "E1004",
      msg: ".use(...) called after .boot() — graph is frozen at boot",
      line: pips.find(p => p.knownAfterBoot)?.line ?? bootLine,
    });
  }

  // Conflict detection — two Pips claiming the same `provides` key
  const seen = new Map();
  for (const p of pips) {
    const meta = PIP_REGISTRY[p.name];
    if (!meta) continue;
    if (seen.has(meta.service)) {
      diagnostics.push({
        sev: "err", code: "E1002",
        msg: `DotConflictError — two Pips claim provides "${meta.service}"`,
        line: p.line,
      });
    } else {
      seen.set(meta.service, p);
    }
  }

  // Unknown plugin — info-level
  for (const p of pips) {
    if (!PIP_REGISTRY[p.name]) {
      diagnostics.push({
        sev: "info", code: "I3001",
        msg: `unknown Pip "${p.name}" — type inference falls back to unknown`,
        line: p.line,
      });
    }
  }

  // Inferred services list — unique, in registration order, known only
  const services = [];
  const visited = new Set();
  for (const p of pips) {
    const meta = PIP_REGISTRY[p.name];
    if (!meta) continue;
    if (visited.has(meta.service)) continue;
    visited.add(meta.service);
    services.push({ key: meta.service, type: meta.type, dts: meta.dts, pip: p.name });
  }

  // Pretend boot time (deterministic from input length so it doesn't dance)
  const bootMs = 6 + (pips.length * 2) + (src.length % 7);

  return { appName, services, diagnostics, pips, bootMs };
}

/* ── the .d.ts string for the Types tab ────────────────── */
function buildDts({ appName, services }) {
  const head =
`<span class="tk-com">// inferred from your source — read-only</span>

<span class="tk-kw">export</span> <span class="tk-kw">type</span> <span class="tk-var">App</span> = <span class="tk-acc">DotApp</span>&lt;<span class="tk-str">${appName ? `"${appName}"` : `"<i>unnamed</i>"`}</span>, {
  <span class="tk-com">// services — typed by the Pip that provided each</span>
`;
  const svc = services.length
    ? services
        .map(
          (s) =>
            `  <span class="tk-var">${s.key}</span>: <span class="tk-acc">${s.type}</span>  <span class="tk-com">// from @arki/${s.pip}</span>`
        )
        .join("\n")
    : `  <span class="tk-dim">// no .use() calls yet — add one to extend the type</span>`;
  const tail =
`
}&gt;

<span class="tk-kw">declare const</span> <span class="tk-var">app</span>: <span class="tk-var">App</span>
${
  services.length
    ? services
        .map(
          (s) =>
            `<span class="tk-com">// app.services.${s.key}.</span><span class="tk-dim"><i>… ${s.dts}</i></span>`
        )
        .join("\n")
    : ""
}`;
  return head + svc + tail;
}

/* ── playground component ──────────────────────────────── */
function Playground() {
  const [src, setSrc]   = useStateDa(DEFAULT_SRC);
  const [tab, setTab]   = useStateDa("code"); // 'code' | 'types' | 'diag'
  const [phase, setPhase] = useStateDa("idle"); // 'idle' | 'compiling'
  const taRef  = useRefDa(null);
  const hlRef  = useRefDa(null);

  // Compile (debounced visual "compiling…" flash)
  const result = useMemoDa(() => compile(src), [src]);
  useEffectDa(() => {
    setPhase("compiling");
    const id = setTimeout(() => setPhase("idle"), 220);
    return () => clearTimeout(id);
  }, [src]);

  const errCount = result.diagnostics.filter(d => d.sev === "err").length;
  const warnCount = result.diagnostics.filter(d => d.sev === "warn").length;

  // Tab keyboard shortcut: 1 / 2 / 3 (when editor not focused)
  useEffectDa(() => {
    const onKey = (e) => {
      if (document.activeElement === taRef.current) return;
      if (e.key === "1") setTab("code");
      if (e.key === "2") setTab("types");
      if (e.key === "3") setTab("diag");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Sync scroll between textarea and highlight overlay
  const onScroll = (e) => {
    if (hlRef.current) {
      hlRef.current.scrollTop  = e.target.scrollTop;
      hlRef.current.scrollLeft = e.target.scrollLeft;
    }
  };

  const lineCount = src.split("\n").length;
  const gutterLines = Array.from({ length: lineCount }, (_, i) => i + 1).join("\n");

  return (
    <figure className="da-pg" aria-labelledby="pg-h">
      {/* HEAD — left label + tabs */}
      <div className="pg-head">
        <div className="lhs">
          <span className="lbl">FIG&nbsp;A1</span>
          <span className="sep">·</span>
          <span>live playground</span>
          <span className="sep">·</span>
          <span>{result.appName ? `app: "${result.appName}"` : "no app name"}</span>
        </div>
        <div className="pg-tabs" role="tablist" aria-label="Playground views">
          <button className={"pg-tab" + (tab === "code"  ? " active" : "")}
                  role="tab" aria-selected={tab === "code"}
                  onClick={() => setTab("code")}>
            <span>Code</span>
            <span className="badge">1</span>
          </button>
          <button className={"pg-tab" + (tab === "types" ? " active" : "")}
                  role="tab" aria-selected={tab === "types"}
                  onClick={() => setTab("types")}>
            <span>Types</span>
            <span className="badge">{result.services.length}</span>
          </button>
          <button className={"pg-tab" + (tab === "diag"  ? " active" : "")}
                  role="tab" aria-selected={tab === "diag"}
                  onClick={() => setTab("diag")}>
            <span>Diagnostics</span>
            <span className={"badge" + (errCount ? " err" : "")}>
              {errCount + warnCount}
            </span>
          </button>
        </div>
      </div>

      {/* BODY */}
      {tab === "code" && (
        <div className="pg-body">
          <div className="pg-editor" style={{ minHeight: 320 }}>
            <div className="gutter" aria-hidden="true">{gutterLines}</div>
            <div className="highlight" ref={hlRef}
                 aria-hidden="true"
                 dangerouslySetInnerHTML={{ __html: highlight(src) + "\n" }} />
            <textarea
              ref={taRef}
              value={src}
              onChange={(e) => setSrc(e.target.value)}
              onScroll={onScroll}
              spellCheck="false"
              autoCorrect="off"
              autoCapitalize="off"
              aria-label="defineApp source — editable"
              wrap="off"
            />
          </div>

          <aside className="pg-side" aria-live="polite">
            <div>
              <div className="ttl">app.services</div>
              <div className="sub">inferred from <code>.use()</code> chain</div>
            </div>
            {result.services.length === 0 && (
              <div className="empty">
                — none yet —<br />
                add a <code>.use(env())</code> to extend the type.
              </div>
            )}
            {result.services.map((s) => (
              <div className="svc" key={s.key}>
                <span className="ck" aria-hidden="true">✓</span>
                <span className="name">
                  app<span className="acc">.</span>services<span className="acc">.</span>{s.key}
                </span>
                <span className="ty">: {s.type}</span>
              </div>
            ))}
            <div className="hint">
              press <span className="kbd">1</span><span className="kbd">2</span><span className="kbd">3</span> to switch tabs
            </div>
          </aside>
        </div>
      )}

      {tab === "types" && (
        <div className="pg-body full">
          <div className="pg-dts"
               dangerouslySetInnerHTML={{ __html: buildDts(result) }} />
        </div>
      )}

      {tab === "diag" && (
        <div className="pg-body full">
          <div className="pg-diag">
            {result.diagnostics.length === 0 && (
              <div className="empty">
                <span className="ok">●</span>
                no diagnostics — the graph compiles clean.
              </div>
            )}
            {result.diagnostics.map((d, i) => (
              <div className="row" key={i}>
                <span className={"gl " + d.sev} aria-hidden="true">
                  {d.sev === "err" ? "✕" : d.sev === "warn" ? "◐" : "○"}
                </span>
                <span className="code">{d.code}</span>
                <span className="msg">{d.msg}</span>
                <span className="ln">L{d.line}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FOOT — status bar */}
      <div className="pg-foot">
        <div className="grp">
          {phase === "compiling" ? (
            <>
              <span className="warn"><span className="dot"></span></span>
              <span>compiling…</span>
            </>
          ) : errCount ? (
            <>
              <span className="err"><span className="dot"></span></span>
              <span className="err">{errCount} error{errCount === 1 ? "" : "s"}</span>
            </>
          ) : (
            <>
              <span className="ok"><span className="dot"></span></span>
              <span>boots in {result.bootMs}ms</span>
            </>
          )}
          <span className="sep">·</span>
          <span>{result.services.length} service{result.services.length === 1 ? "" : "s"}</span>
          <span className="sep">·</span>
          <span>{result.pips.length} Pip{result.pips.length === 1 ? "" : "s"}</span>
          {warnCount > 0 && (
            <>
              <span className="sep">·</span>
              <span className="warn">{warnCount} warning{warnCount === 1 ? "" : "s"}</span>
            </>
          )}
        </div>
        <div className="grp">
          <span>typescript 5.4</span>
          <span className="sep">·</span>
          <button className="reset" onClick={() => setSrc(DEFAULT_SRC)}>
            reset
          </button>
        </div>
      </div>
    </figure>
  );
}

/* ── concept sidebar — defineApp active ───────────────── */
function ConceptSideDa() {
  const items = [
    { g: "Getting started" },
    { ord: "10", label: "Install" },
    { ord: "12", label: "First app" },
    { ord: "13", label: "First run" },
    { g: "Concepts" },
    { ord: "21", label: "defineApp", active: true },
    { ord: "22", label: "Pip contract" },
    { ord: "23", label: "Lifecycle" },
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
          <a key={it.ord} href={it.label === "Lifecycle" ? "Lifecycle.html" : "#"}
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

/* ── right-rail TOC ─────────────────────────────────────── */
function ConceptTocDa() {
  return (
    <aside className="lc-toc" aria-label="On this page">
      <div className="ttl">on this page</div>
      <a href="#what">What it does</a>
      <a href="#signature">The signature</a>
      <a href="#playground" className="active">Live playground</a>
      <a href="#inference">Type inference</a>
      <a href="#boot">What .boot() does</a>
      <a href="#mistakes">Common mistakes</a>
      <a href="#" style={{ marginTop: 12, color: "var(--accent)" }}>
        edit on github ↗
      </a>
    </aside>
  );
}

/* ── boot order steps ──────────────────────────────────── */
function BootSteps() {
  const steps = [
    { body: (<>Resolve the Pip <code>provides</code>/<code>requires</code> graph and compute topological order.</>), glyph: "topo" },
    { body: (<>Call <code>configure(ctx)</code> on every Pip in topo order. Sync. No I/O.</>), glyph: "sync" },
    { body: (<>Call <code>boot(ctx)</code> on every Pip in topo order. Async. Connections open, migrations run.</>), glyph: "async · I/O" },
    { body: (<>Aggregate each Pip's <code>provides</code> into <code>app.services</code> and merge their <code>manifest</code> entries.</>), glyph: "merge" },
    { body: (<>Return the booted <code>app</code>. <code>.boot()</code> is idempotent past this point.</>), glyph: "ready" },
  ];
  return (
    <div className="da-boot">
      <div className="head">
        <span>boot-order.ts</span>
        <span>after .boot() resolves</span>
      </div>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            <span className="body">{s.body}</span>
            <span className="glyph">{s.glyph}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ── inferred-services A4 block ────────────────────────── */
function ServicesA4() {
  const rows = [
    { svc: "env",    ty: "EnvService",  a4: "A4 · provided by @arki/env" },
    { svc: "db",     ty: "DbClient",    a4: "A4 · provided by @arki/db" },
    { svc: "kv",     ty: "KvStore",     a4: "A4 · provided by @arki/kv" },
  ];
  return (
    <div className="da-svc-block">
      <div className="head">
        <span>inferred-services.d.ts</span>
        <span>read-only</span>
      </div>
      <div className="body">
        {rows.map((r, i) => (
          <React.Fragment key={i}>
            <div className="rule">
              <span className="ck">✓</span>{" "}
              app<span className="acc">.</span>services<span className="acc">.</span>{r.svc}
              <span className="ty">  : {r.ty}</span>
            </div>
            <div className="a4">{r.a4}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

/* ── common mistakes ────────────────────────────────────── */
function Mistakes() {
  const items = [
    {
      title: "Forgetting to await .boot()",
      code: "E1003",
      bad:
`<span class="tk-kw">const</span> <span class="tk-var">app</span> = <span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">env</span>())
  .<span class="tk-fn">boot</span>()
<span class="tk-com">// app is Promise&lt;App&gt; — services unreachable</span>`,
      good:
`<span class="tk-kw">const</span> <span class="tk-var">app</span> = <span class="tk-kw">await</span> <span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">env</span>())
  .<span class="tk-fn">boot</span>()
<span class="tk-com">// app is App — services typed and ready</span>`,
    },
    {
      title: "Calling .use() after .boot()",
      code: "E1004",
      bad:
`<span class="tk-kw">const</span> <span class="tk-var">app</span> = <span class="tk-kw">await</span> <span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">env</span>())
  .<span class="tk-fn">boot</span>()
<span class="tk-var">app</span>.<span class="tk-fn">use</span>(<span class="tk-fn">db</span>())  <span class="tk-com">// graph frozen → throws</span>`,
      good:
`<span class="tk-kw">const</span> <span class="tk-var">app</span> = <span class="tk-kw">await</span> <span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">env</span>())
  .<span class="tk-fn">use</span>(<span class="tk-fn">db</span>())
  .<span class="tk-fn">boot</span>()`,
    },
    {
      title: "Two Pips claiming the same provides key",
      code: "E1002",
      bad:
`<span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">db</span>({ url: <span class="tk-str">"…"</span> }))
  .<span class="tk-fn">use</span>(<span class="tk-fn">db</span>({ url: <span class="tk-str">"…"</span> }))
<span class="tk-com">// DotConflictError at boot — provides "db" twice</span>`,
      good:
`<span class="tk-fn">defineApp</span>(<span class="tk-str">"billing"</span>)
  .<span class="tk-fn">use</span>(<span class="tk-fn">db</span>({ url: <span class="tk-str">"…"</span> }))
  .<span class="tk-fn">use</span>(<span class="tk-fn">kv</span>())
<span class="tk-com">// every service key claimed by exactly one Pip</span>`,
    },
  ];
  return (
    <div className="da-mistakes">
      {items.map((m, i) => (
        <div className="da-mistake" key={i}>
          <div className="ttl">
            <span>{m.title}</span>
            <span className="code">{m.code}</span>
          </div>
          <div className="pair">
            <div className="col no">
              <div className="lbl"><span>✕</span> won't compile</div>
              <pre dangerouslySetInnerHTML={{ __html: m.bad }} />
            </div>
            <div className="col yes">
              <div className="lbl"><span>✓</span> do this instead</div>
              <pre dangerouslySetInnerHTML={{ __html: m.good }} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── inline signature block (intro) ────────────────────── */
function SignatureBlock() {
  const sig =
`<span class="tk-kw">function</span> <span class="tk-fn">defineApp</span>&lt;<span class="tk-var">TName</span> <span class="tk-kw">extends</span> <span class="tk-var">string</span>&gt;(
  <span class="tk-var">name</span>: <span class="tk-var">TName</span>,
): <span class="tk-fn">DotAppBuilder</span>&lt;<span class="tk-var">TName</span>, {}&gt;`;
  const [copied, setCopied] = useStateDa(false);
  const onCopy = () => {
    try {
      navigator.clipboard.writeText(
`function defineApp<TName extends string>(
  name: TName,
): DotAppBuilder<TName, {}>`
      );
    } catch (e) {}
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="da-sig">
      <div className="head">
        <span>defineApp.d.ts</span>
        <button className={"copy" + (copied ? " ok" : "")} onClick={onCopy}>
          {copied ? "copied" : "Copy"}
        </button>
      </div>
      <pre dangerouslySetInnerHTML={{ __html: sig }} />
      <div className="foot">
        <span>@arki/dot · packages/dot/src/define-app.ts</span>
        <a href="#">view source ↗</a>
      </div>
    </div>
  );
}

/* ── the screen ────────────────────────────────────────── */
function DefineApp() {
  return (
    <main className="container" id="main">
      <div className="lc-grid">
        <ConceptSideDa />

        <article className="lc-main">
          <nav className="breadcrumb" aria-label="Breadcrumb">
            <a href="#">Docs</a>
            <span className="sep">/</span>
            <a href="#">Concepts</a>
            <span className="sep">/</span>
            <span className="here">defineApp</span>
          </nav>

          <h1>
            defineApp<span className="dot">(</span>name<span className="dot">)</span>
          </h1>

          <p className="lede">
            <span className="fg"><code>defineApp</code> is the framework's app builder.</span>{" "}
            You call it once per app, chain <code>.use()</code> calls per Pip,
            and <span className="fg"><code>await .boot()</code></span> to start
            the lifecycle. Every <code>.use()</code> extends the inferred
            <code> app.services</code> type — there is no runtime registry,
            no separate manifest file.
          </p>

          <h2 id="signature">
            <span>The signature</span>
            <span className="anchor">#signature</span>
          </h2>
          <p className="muted">
            One function, one generic parameter. The chained builder is where
            all the type machinery lives.
          </p>
          <SignatureBlock />

          <h2 id="playground">
            <span>Live playground</span>
            <span className="anchor">#playground</span>
          </h2>
          <p>
            Edit the source. Watch <code>app.services</code> recompute as you
            add or remove <code>.use()</code> calls. Switch to{" "}
            <strong>Types</strong> for the synthesised <code>.d.ts</code>, or{" "}
            <strong>Diagnostics</strong> for boot-time errors. Nothing runs on
            a server — the parser is in your browser, deterministic, and the
            same one <code>dot doctor</code> ships with.
          </p>
          <Playground />
          <figcaption className="da-figcap">
            <span className="k">FIG&nbsp;A1</span>
            <span>
              The playground recompiles on every keystroke. Try adding{" "}
              <code>.use(http())</code>, removing <code>await</code>, or
              calling <code>.use(db())</code> twice — each edit surfaces a
              different facet of the contract.
            </span>
          </figcaption>

          <h2 id="inference">
            <span>How type inference works</span>
            <span className="anchor">#inference</span>
          </h2>
          <p>
            Each <code>.use(plugin)</code> returns a new builder whose service
            map is extended with whatever that plugin <code>provides</code>.
            After <code>boot()</code>, the resolved <code>app.services</code>{" "}
            is the union of every Pip's contribution — typed by the Pip that
            registered it, not by a central registry.
          </p>
          <ServicesA4 />
          <p className="muted">
            Hover any service in your IDE to see its full <code>.d.ts</code> —
            the same envelope <code>dot doctor --json</code> reports at boot
            time. There is no second source of truth.
          </p>

          <h2 id="boot">
            <span>What .boot() does</span>
            <span className="anchor">#boot</span>
          </h2>
          <p>
            <code>.boot()</code> is the only side-effecting call on the
            builder. It runs in five stages, in order, and returns the
            resolved app. Failures roll back in reverse topological order —
            see <a href="Lifecycle.html" style={{color:"var(--accent)"}}>23 — Lifecycle</a>.
          </p>
          <BootSteps />

          <h2 id="mistakes">
            <span>Common mistakes</span>
            <span className="anchor">#mistakes</span>
          </h2>
          <p>
            The compiler catches most of these at edit time — the playground
            above surfaces the same diagnostics live.
          </p>
          <Mistakes />

          <a className="lc-next" href="#">
            <div className="l">
              <span className="k">read next →</span>
              <span className="t">The Pip contract</span>
              <span className="s">/docs/concepts/pip-contract &nbsp;·&nbsp; 22</span>
            </div>
            <span className="arr">→</span>
          </a>
        </article>

        <ConceptTocDa />
      </div>
    </main>
  );
}

Object.assign(window, { DefineApp });
