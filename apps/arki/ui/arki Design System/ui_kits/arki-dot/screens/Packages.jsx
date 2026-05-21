// Packages catalog — /packages

const PACKAGES = {
  Foundation: [
    { name: "@arki/dot",        desc: "Kernel. defineApp, lifecycle, Pip graph, diagnostics.",   status: "ready",    v: "v0.1.0", size: "9.2 KB" },
    { name: "@arki/types",      desc: "Public type primitives. Shared by every other package.",  status: "ready",    v: "v0.1.0", size: "3.1 KB" },
    { name: "@arki/diagnostics",desc: "Structured envelopes. dot doctor source-of-truth.",       status: "ready",    v: "v0.1.0", size: "5.8 KB" },
  ],
  Adapters: [
    { name: "@arki/env",        desc: "Typed environment loader. .env + schema + .env.example.", status: "ready",    v: "v0.1.0", size: "4.3 KB" },
    { name: "@arki/db",         desc: "Database adapter. Postgres, MySQL, SQLite. Migrations.",  status: "ready",    v: "v0.1.0", size: "14.4 KB" },
    { name: "@arki/kv",         desc: "Key-value adapter. Memory, Redis, Cloudflare KV.",        status: "ready",    v: "v0.1.0", size: "6.1 KB" },
    { name: "@arki/auth",       desc: "Session-based auth. Cookies, JWT, OAuth providers.",      status: "canary",   v: "v0.0.9", size: "11.2 KB" },
    { name: "@arki/queue",      desc: "Background jobs. PG-driven, BullMQ, Cloudflare Queues.",  status: "canary",   v: "v0.1.0-rc.3", size: "9.7 KB" },
    { name: "@arki/rpc",        desc: "Typed client/server RPC. tRPC-style inference.",          status: "canary",   v: "v0.1.0-rc.1", size: "7.4 KB" },
  ],
  CLI: [
    { name: "@arki/cli",        desc: "The dot binary. doctor, explain, trace, migrate.",        status: "ready",    v: "v0.1.0", size: "22.0 KB" },
    { name: "@arki/codemod",    desc: "Schema-aware codemods. Run from dot upgrade.",            status: "alpha",    v: "v0.0.2", size: "8.5 KB" },
  ],
  Frontend: [
    { name: "@arki/start",      desc: "TanStack Start adapter. SSR + idle hydration.",           status: "alpha",    v: "v0.0.4", size: "6.9 KB" },
    { name: "@arki/react",      desc: "React bindings for typed app services.",                  status: "planned",  v: "—",     size: "—" },
  ],
};

function Packages({ setRoute }) {
  const [filters, setFilters] = React.useState(["ready", "canary"]);
  const toggle = (f) => setFilters(filters.includes(f) ? filters.filter(x => x !== f) : [...filters, f]);

  return (
    <main className="container pkgs">
      <h1>Packages</h1>
      <p className="lede">
        Every package is published to npm with a stable name, a tested fixture set,
        and a documented public API. The list below mirrors <code>npm pack --dry-run --json</code>
        on the release tag.
      </p>

      <div className="chip-rail" role="group" aria-label="Filter by status">
        {["ready","canary","alpha","planned"].map(f => (
          <button key={f} className={"chip" + (filters.includes(f) ? " active" : "")} onClick={() => toggle(f)}>
            {filters.includes(f) ? "✓ " : ""}{f}
            {filters.includes(f) && <span className="x">×</span>}
          </button>
        ))}
        <button className="chip">runtime: node</button>
        <button className="chip">runtime: bun</button>
        <button className="chip">runtime: workers</button>
        <button className="chip">zero-deps only</button>
      </div>

      {Object.entries(PACKAGES).map(([group, rows]) => {
        const visible = rows.filter(r => filters.includes(r.status));
        if (visible.length === 0) return null;
        return (
          <section key={group}>
            <div className="pkg-group-h">
              <span>{group}</span>
              <span className="count">{visible.length}</span>
              <span className="rule"></span>
            </div>
            <div className="pkg-table">
              {visible.map(r => (
                <div className="pkg-row" key={r.name}>
                  <div className="pkg-name">{r.name}</div>
                  <div className="pkg-desc">{r.desc}</div>
                  <div><Pill status={r.status === "ready" ? "success" : r.status === "canary" ? "warning" : r.status === "alpha" ? "info" : "idle"}>{r.status}</Pill></div>
                  <div className="pkg-v">{r.v}</div>
                  <div className="pkg-size">{r.size}</div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

      <div style={{display:"flex", justifyContent:"center", padding:"32px 0 0", color:"var(--muted-foreground)", fontFamily:"var(--font-mono)", fontSize:12}}>
        ⎯ that's everything ⎯
      </div>
    </main>
  );
}

window.Packages = Packages;
