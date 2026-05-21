// Concept page — /docs/concepts/lifecycle

function Concept({ setRoute }) {
  return (
    <main className="container">
      <div className="doc-grid">
        {/* Left nav */}
        <aside className="doc-side" aria-label="Documentation sections">
          <div className="group">Getting started</div>
          <a href="#">Install</a>
          <a href="#">Your first app</a>
          <a href="#">Project layout</a>
          <div className="group">Concepts</div>
          <a href="#" className="active">Lifecycle</a>
          <a href="#">Plugins (Pip)</a>
          <a href="#">defineApp</a>
          <a href="#">Diagnostics</a>
          <a href="#">Adapters</a>
          <a href="#">Multi-runtime</a>
          <div className="group">Guides</div>
          <a href="#">Postgres</a>
          <a href="#">Auth + sessions</a>
          <a href="#">Background jobs</a>
        </aside>

        {/* Main */}
        <article className="doc-main">
          <div className="breadcrumb">
            <a href="#">Docs</a><span className="sep">/</span>
            <a href="#">Concepts</a><span className="sep">/</span>
            <span style={{color:"var(--foreground)"}}>Lifecycle</span>
          </div>

          <h1>The lifecycle</h1>
          <p className="lede">
            Every DOT app moves through five hooks in a guaranteed order:
            <code>configure</code>, <code>boot</code>, <code>start</code>,
            <code>stop</code>, <code>dispose</code>. Each plugin (a <em>Pip</em>) opts
            into the hooks it needs. The order is fixed; the work inside it is yours.
          </p>

          <CodeBlock
            filename="examples/billing/src/app.ts"
            code={
              <>
                {Tk.kw("export const")} {Tk.v("app")}{" = "}{Tk.kw("await")}{" "}{Tk.fn("defineApp")}{"("}{Tk.str("'billing'")}{")\n"}
                {"  ."}{Tk.fn("use")}{"("}{Tk.fn("db")}{"({ schema }))\n"}
                {"  ."}{Tk.fn("use")}{"("}{Tk.fn("queue")}{"({ driver: "}{Tk.str("'pg'")}{" }))\n"}
                {"  ."}{Tk.fn("boot")}{"();    "}{Tk.com("// configure → boot, ready")}
              </>
            }
            copyValue={`export const app = await defineApp('billing')\n  .use(db({ schema }))\n  .use(queue({ driver: 'pg' }))\n  .boot();`}
            provenance={{ label: "fixture: packages/dot/__fixtures__/lifecycle.basic.ts" }}
          />

          <h2 id="hooks">The five hooks</h2>
          <p>Each hook receives the typed app context, may register additional services,
          and may return a teardown callback that runs in reverse order on <code>dispose</code>.</p>

          <ul>
            <li><code>configure(ctx)</code> — read env, validate config, register types. <em>Cannot</em> touch IO.</li>
            <li><code>boot(ctx)</code> — open connections, run migrations, warm caches. May touch IO.</li>
            <li><code>start(ctx)</code> — accept traffic. HTTP listeners, queue workers, schedulers.</li>
            <li><code>stop(ctx)</code> — drain in-flight work, stop accepting new traffic. SIGTERM lands here.</li>
            <li><code>dispose(ctx)</code> — close connections, flush logs, release resources.</li>
          </ul>

          <div className="ascii-diagram" aria-hidden="true">
{`                                                                       
   ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐    ┌────────────┐
   │            │    │            │    │            │    │            │    │            │
   │  `}<span className="ascii-pulse ap1">●</span>{` config  │━━▶│   `}<span className="ascii-pulse ap2">●</span>{` boot   │━━▶│   `}<span className="ascii-pulse ap3">●</span>{` start  │━━▶│   `}<span className="ascii-pulse ap4">●</span>{` stop   │━━▶│  `}<span className="ascii-pulse ap5">●</span>{` dispose │
   │            │    │            │    │            │    │            │    │            │
   │   env      │    │   db ↑     │    │   http ▣   │    │   drain    │    │   close    │
   │   types    │    │   kv ↑     │    │   queue ▣  │    │   reject   │    │   flush    │
   │            │    │   queue ↑  │    │   sched ▣  │    │            │    │            │
   └────────────┘    └────────────┘    └────────────┘    └────────────┘    └────────────┘
      `}<span className="d">no I/O</span>{`             `}<span className="d">I/O ok</span>{`           `}<span className="d">accept</span>{`             `}<span className="d">drain</span>{`           `}<span className="d">release</span>{`
`}
          </div>

          <h2 id="ordering">Hook ordering across plugins</h2>
          <p>Within a single hook, plugins run in the order they were registered.
          Across hooks, the order is fixed. <code>dispose</code> runs teardown
          callbacks in <strong>reverse</strong> registration order — last opened, first closed.</p>

          <h3 id="diagnostics">If a hook fails</h3>
          <p>A failed hook produces a structured envelope on stderr and exits with
          a stable code. <code>dot doctor --json</code> returns the same shape.</p>

          <CodeBlock
            filename="dot doctor --json (excerpt)"
            lang="json"
            code={
              <>
                {"{\n"}
                {"  "}{Tk.str('"app"')}{": "}{Tk.str('"billing"')}{",\n"}
                {"  "}{Tk.str('"phase"')}{": "}{Tk.str('"boot"')}{",\n"}
                {"  "}{Tk.str('"failedPlugin"')}{": "}{Tk.str('"@arki/db"')}{",\n"}
                {"  "}{Tk.str('"error"')}{": {\n"}
                {"    "}{Tk.str('"code"')}{": "}{Tk.str('"DB_CONNECT_REFUSED"')}{",\n"}
                {"    "}{Tk.str('"host"')}{": "}{Tk.str('"localhost:5432"')}{",\n"}
                {"    "}{Tk.str('"fixUrl"')}{": "}{Tk.str('"https://arki.dev/cli/doctor#db-connect"')}{"\n"}
                {"  },\n"}
                {"  "}{Tk.str('"confidence"')}{": "}{Tk.str('"high"')}{"\n"}
                {"}"}
              </>
            }
            copyValue={'{ "app": "billing", "phase": "boot", "failedPlugin": "@arki/db" }'}
            provenance={{ label: "envelope: packages/dot/src/diagnostics/envelope.ts" }}
          />
        </article>

        {/* TOC */}
        <aside className="doc-toc" aria-label="Table of contents">
          <div className="ttl">On this page</div>
          <a href="#hooks">The five hooks</a>
          <a href="#ordering" className="active">Hook ordering</a>
          <a href="#diagnostics">If a hook fails</a>
          <a href="#" style={{marginTop:14, color:"var(--accent)"}}>edit on github ↗</a>
        </aside>
      </div>
    </main>
  );
}

window.Concept = Concept;
