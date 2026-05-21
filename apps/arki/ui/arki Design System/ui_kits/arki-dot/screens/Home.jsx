// Home screen — /
// First viewport: install command + defineApp() hero + ASCII band

function Home({ setRoute }) {
  const [pkg, setPkg] = React.useState("bun");
  const installs = {
    bun: "bun add @arki/dot",
    npm: "npm install @arki/dot",
    pnpm: "pnpm add @arki/dot",
    yarn: "yarn add @arki/dot",
  };
  const [copied, setCopied] = React.useState(false);
  const doCopy = () => {
    try { navigator.clipboard.writeText(installs[pkg]); } catch(e){}
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  };

  return (
    <main className="container hero">
      <h1>Ship faster<span style={{color:"var(--accent)"}}>.</span> Build smarter<span style={{color:"var(--accent)"}}>.</span></h1>
      <p className="lede">
        <span className="fg">DOT</span> is a TypeScript-first application composition framework.
        Tiny multi-runtime kernel, fully typed plugin graph, package-owned adapters for env, db, kv,
        auth, queue, and RPC. <span className="fg">Tested examples</span>, structured diagnostics,
        agent-native CLI.
      </p>

      <div className="hero-grid">
        {/* LEFT: defineApp() hero snippet */}
        <CodeBlock
          filename="examples/billing/src/app.ts"
          code={
            <>
              {Tk.kw("import")} {"{ "}{Tk.fn("defineApp")}{" } "}{Tk.kw("from")} {Tk.str("'@arki/dot'")}{";\n"}
              {Tk.kw("import")} {"{ "}{Tk.fn("db")}{" } "}{Tk.kw("from")} {Tk.str("'@arki/db/dot'")}{";\n"}
              {Tk.kw("import")} {"{ "}{Tk.fn("queue")}{" } "}{Tk.kw("from")} {Tk.str("'@arki/queue/dot'")}{";\n"}
              {Tk.kw("import")} {"{ "}{Tk.v("schema")}{" } "}{Tk.kw("from")} {Tk.str("'./schema'")}{";\n\n"}
              {Tk.kw("export const")} {Tk.v("app")}{" = "}{Tk.kw("await")}{" "}{Tk.fn("defineApp")}{"("}{Tk.str("'billing'")}{")\n"}
              {"  ."}{Tk.fn("use")}{"("}{Tk.fn("db")}{"({ schema }))\n"}
              {"  ."}{Tk.fn("use")}{"("}{Tk.fn("queue")}{"({ driver: "}{Tk.str("'pg'")}{" }))\n"}
              {"  ."}{Tk.fn("boot")}{"();\n\n"}
              {Tk.com("// type Services = { db: DB<typeof schema>; queue: Queue }")}
            </>
          }
          copyValue={`import { defineApp } from '@arki/dot';\nimport { db } from '@arki/db/dot';\n\nexport const app = await defineApp('billing')\n  .use(db({ schema }))\n  .boot();`}
          provenance={{ label: "fixture: packages/dot/__fixtures__/defineApp.basic.ts" }}
        />

        {/* RIGHT: install + meta */}
        <div style={{display:"flex", flexDirection:"column", gap: 16}}>
          <div className="code-block">
            <div className="head">
              <div className="install-tabs">
                {Object.keys(installs).map(k => (
                  <button key={k} className={"install-tab" + (k===pkg ? " active" : "")} onClick={() => setPkg(k)}>{k}</button>
                ))}
              </div>
              <button className={"copy" + (copied ? " ok" : "")} onClick={doCopy}>{copied ? "copied" : "Copy"}</button>
            </div>
            <pre style={{fontSize: 14}}>{Tk.com("$ ")}{installs[pkg]}</pre>
            <div className="provenance">
              <span>v0.1.0 · 9.2 KB · 7 files · zero deps</span>
              <a href="#">npm pack --json ↗</a>
            </div>
          </div>

          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap: 10}}>
            <div className="card" onClick={() => setRoute("concept")} style={{cursor:"pointer"}}>
              <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted-foreground)"}}>READ</div>
              <div style={{fontFamily:"var(--font-sans)", fontSize:14, fontWeight:500, marginTop:4}}>The lifecycle</div>
              <div style={{fontSize:12, color:"var(--muted-foreground)", marginTop:4, lineHeight:"17px"}}>
                Five hooks: configure, boot, start, stop, dispose.
              </div>
            </div>
            <div className="card" onClick={() => setRoute("cli")} style={{cursor:"pointer"}}>
              <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted-foreground)"}}>RUN</div>
              <div style={{fontFamily:"var(--font-sans)", fontSize:14, fontWeight:500, marginTop:4}}>dot doctor</div>
              <div style={{fontSize:12, color:"var(--muted-foreground)", marginTop:4, lineHeight:"17px"}}>
                Diagnose plugin failures with a JSON envelope.
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ASCII DAG — the package graph, rendered as art */}
      <section style={{marginTop: 56, padding: "24px 0", borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)"}}>
        <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted-foreground)", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:14, display:"flex", alignItems:"center", gap:10}}>
          <span style={{color:"var(--accent)"}}>graph</span>
          <span style={{flex:1, height:1, background:"var(--border)"}}></span>
          <span>dot explain --graph</span>
        </div>
        <pre className="ascii-art" style={{fontSize: 13, lineHeight: "18px"}}>
{`                                ┌──── @arki/env       `}<span className="d">v0.1.0</span>{`   typed env loader
                                │
                                ├──── @arki/db        `}<span className="d">v0.1.0</span>{`   pg · mysql · sqlite
                                │
   @arki/dot   `}<span className="ascii-pulse ap1">●</span>{`━━━━━━━━━━━━━━━━━┼──── @arki/kv        `}<span className="d">v0.1.0</span>{`   memory · redis · cf
   `}<span className="d">kernel</span>{`                        │
                                ├──── @arki/auth      `}<span className="wrn">v0.0.9</span>{`   sessions · jwt · oauth   `}<span className="wrn">◐ canary</span>{`
                                │
                                ├──── @arki/queue     `}<span className="wrn">v0.1.0-rc.3</span>{`   pg · bullmq · cf    `}<span className="wrn">◐ canary</span>{`
                                │
                                └──── @arki/rpc       `}<span className="wrn">v0.1.0-rc.1</span>{`   typed client/server  `}<span className="wrn">◐ canary</span>{`
`}
        </pre>
        <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--muted-foreground)", marginTop:8, display:"flex", justifyContent:"space-between"}}>
          <span><span className="ascii-pulse ap1" style={{color:"var(--accent)"}}>●</span> ready · <span style={{color:"hsl(43 96% 60%)"}}>◐</span> canary · <span style={{color:"hsl(217 85% 65%)"}}>○</span> alpha</span>
          <a href="#" style={{color:"var(--accent)"}}>cat llms.txt ↗</a>
        </div>
      </section>

      {/* Below-fold: peer respect + agents */}
      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap: 24, marginTop: 64}}>
        <section>
          <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--accent)", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8}}>
            Different jobs
          </div>
          <h2 style={{fontSize:24, lineHeight:"32px", fontWeight:600, letterSpacing:"-0.015em", margin:"0 0 12px"}}>
            Hono routes. Elysia infers. DOT composes.
          </h2>
          <p style={{color:"var(--muted-foreground)", fontSize:14, lineHeight:"22px", margin:0}}>
            arki frames itself in terms of jobs-to-be-done. Hono and Elysia
            are world-class HTTP libraries. AdonisJS is the mature opinionated
            framework that taught the JS world about product discipline. DOT
            composes <em>app runtimes</em> — env, db, kv, auth, queue, RPC —
            on top of whichever runtime you use.
          </p>
        </section>
        <section>
          <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--accent)", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8}}>
            Agent-native
          </div>
          <h2 style={{fontSize:24, lineHeight:"32px", fontWeight:600, letterSpacing:"-0.015em", margin:"0 0 12px"}}>
            Every page humans read has a JSON envelope.
          </h2>
          <p style={{color:"var(--muted-foreground)", fontSize:14, lineHeight:"22px", margin:0}}>
            <code style={{fontFamily:"var(--font-mono)", background:"var(--muted)", padding:"1px 6px", borderRadius:3, color:"var(--foreground)"}}>llms.txt</code> is current and linked from chrome. Code blocks have stable anchor IDs.
            CLI output is shown as both <code style={{fontFamily:"var(--font-mono)", background:"var(--muted)", padding:"1px 6px", borderRadius:3, color:"var(--foreground)"}}>--json</code> envelope and human format. A coding
            agent reads the same content you do.
          </p>
        </section>
      </div>
    </main>
  );
}

window.Home = Home;
