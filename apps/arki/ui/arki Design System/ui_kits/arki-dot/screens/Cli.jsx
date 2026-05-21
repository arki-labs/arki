// CLI man page — /cli/doctor
function Cli({ setRoute }) {
  return (
    <main className="container">
      <div className="cli-grid">
        <aside className="cli-side" aria-label="CLI commands">
          <div className="group">app</div>
          <a href="#">dot init</a>
          <a href="#">dot dev</a>
          <a href="#">dot build</a>
          <div className="group">diag</div>
          <a href="#" className="active">dot doctor</a>
          <a href="#">dot explain</a>
          <a href="#">dot trace</a>
          <div className="group">ops</div>
          <a href="#">dot migrate</a>
          <a href="#">dot queue</a>
          <a href="#">dot kv</a>
        </aside>

        <article className="cli-main">
          <h1>dot doctor<span style={{color:"var(--muted-foreground)"}}>(1)</span></h1>
          <div className="meta">arki user commands · v0.1.0</div>

          <h2><span className="kbd">s</span> SYNOPSIS</h2>
          <pre className="synopsis">{"$ dot doctor "}<span className="a">[--json]</span>{" "}<span className="a">[--phase=&lt;hook&gt;]</span>{" "}<span className="a">[--app=&lt;name&gt;]</span></pre>

          <h2><span className="kbd">d</span> DESCRIPTION</h2>
          <p>
            Run a diagnostic sweep on the current arki app. <code>dot doctor</code> walks each
            registered plugin (Pip), executes its configure hook in dry-run mode, and reports
            structured failures. Pass <code>--json</code> to emit a stable envelope suitable for
            agent or CI consumption. Exit code 0 on full pass, 1 on diagnosed failure, 2 on
            unknown failure.
          </p>

          <h2><span className="kbd">o</span> OPTIONS</h2>
          <table className="opts">
            <tbody>
              <tr><td>--json</td><td>Emit the structured envelope instead of human-readable output. Pairs with <code>jq</code>, MCP, or agents.</td></tr>
              <tr><td>--phase=&lt;hook&gt;</td><td>Restrict the sweep to a single lifecycle hook: <code>configure</code>, <code>boot</code>, <code>start</code>, <code>stop</code>, <code>dispose</code>.</td></tr>
              <tr><td>--app=&lt;name&gt;</td><td>Run against a named app in a multi-app project. Default: first app declared in <code>arki.config.ts</code>.</td></tr>
              <tr><td>--strict</td><td>Treat unknown plugins as failure. Default: warn only.</td></tr>
              <tr><td>--no-color</td><td>Disable ANSI color output. Implied when stdout is not a TTY.</td></tr>
            </tbody>
          </table>

          <h2><span className="kbd">e</span> EXAMPLES</h2>
          <CodeBlock
            filename="terminal"
            code={
              <>
                <span style={{color:"var(--accent)"}}>$</span> dot doctor{"\n"}
                <span className="tk-com">→ configure ✓ </span><span style={{color:"hsl(142 65% 55%)"}}>db</span><span className="tk-com">  ✓ </span><span style={{color:"hsl(142 65% 55%)"}}>kv</span><span className="tk-com">  ✓ </span><span style={{color:"hsl(142 65% 55%)"}}>queue</span>{"\n"}
                <span className="tk-com">→ boot      ✗ </span><span style={{color:"hsl(0 63% 60%)"}}>db</span>{"\n"}
                {"          "}<span style={{color:"hsl(0 63% 60%)"}}>DB_CONNECT_REFUSED</span><span className="tk-com"> at localhost:5432</span>{"\n"}
                {"          "}<span className="tk-com">fix → </span><span style={{color:"var(--accent)"}}>https://arki.dev/cli/doctor#db-connect</span>{"\n\n"}
                <span style={{color:"var(--accent)"}}>$</span> dot doctor --json | jq .failedPlugin{"\n"}
                <span style={{color:"#9ecbff"}}>"@arki/db"</span>
              </>
            }
            copyValue="dot doctor"
            provenance={{ label: "captured: ci/2026-05-21/run-802cf4e" }}
          />

          <h2><span className="kbd">x</span> EXIT STATUS</h2>
          <table className="opts">
            <tbody>
              <tr><td>0</td><td>All plugins pass the sweep.</td></tr>
              <tr><td>1</td><td>One or more diagnosed failures with a known fix URL.</td></tr>
              <tr><td>2</td><td>One or more failures with no diagnosis. <code>confidence: low</code>.</td></tr>
            </tbody>
          </table>

          <h2>SEE ALSO</h2>
          <p style={{fontFamily:"var(--font-mono)", color:"var(--muted-foreground)"}}>
            dot explain(1) · dot trace(1) · /docs/concepts/lifecycle
          </p>
        </article>

        {/* JSON envelope panel — agent-native peer */}
        <aside className="cli-aside" aria-label="JSON envelope">
          <div>
            <div className="lbl">JSON envelope · agent peer</div>
            <CodeBlock
              filename="dot doctor --json"
              lang="json"
              code={
                <>
                  {"{\n"}
                  {"  "}{Tk.str('"app"')}{": "}{Tk.str('"billing"')}{",\n"}
                  {"  "}{Tk.str('"phase"')}{": "}{Tk.str('"boot"')}{",\n"}
                  {"  "}{Tk.str('"ok"')}{": "}{Tk.b("false")}{",\n"}
                  {"  "}{Tk.str('"failedPlugin"')}{": "}{Tk.str('"@arki/db"')}{",\n"}
                  {"  "}{Tk.str('"error"')}{": {\n"}
                  {"    "}{Tk.str('"code"')}{": "}{Tk.str('"DB_CONNECT_REFUSED"')}{",\n"}
                  {"    "}{Tk.str('"host"')}{": "}{Tk.str('"localhost:5432"')}{",\n"}
                  {"    "}{Tk.str('"fixUrl"')}{": "}{Tk.str('"…#db-connect"')}{"\n"}
                  {"  },\n"}
                  {"  "}{Tk.str('"confidence"')}{": "}{Tk.str('"high"')}{",\n"}
                  {"  "}{Tk.str('"runId"')}{": "}{Tk.str('"802cf4e"')}{"\n"}
                  {"}"}
                </>
              }
              copyValue='{"app":"billing","phase":"boot","ok":false}'
              provenance={{ label: "schema: dot.diagnostics.v1" }}
            />
          </div>
          <div style={{padding:"10px 12px", border:"1px solid var(--border)", borderRadius:6, background:"var(--card)"}}>
            <div className="lbl">Keyboard</div>
            <div style={{fontFamily:"var(--font-mono)", fontSize:12, color:"var(--muted-foreground)", lineHeight:"22px"}}>
              <div><Kbd>s</Kbd> jump to SYNOPSIS</div>
              <div><Kbd>o</Kbd> jump to OPTIONS</div>
              <div><Kbd>e</Kbd> jump to EXAMPLES</div>
              <div><Kbd>x</Kbd> jump to EXIT STATUS</div>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}

window.Cli = Cli;
