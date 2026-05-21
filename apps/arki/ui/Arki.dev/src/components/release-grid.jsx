// ────────────────────────────────────────────────────────────────
// Release status — compressed view (top 5 packages × 5 gates).
// Each row: package name · 5 gate pills · stability tag · view link.
// Matches the 00-home spec wireframe ("D1 widget").
// ────────────────────────────────────────────────────────────────

const RELEASE_GATES = ["pack", "leak", "fixtures", "types", "docs"];

const RELEASE_ROWS = [
  { pkg: "@arki/dot",   gates: ["ok","ok","ok","ok","ok"], stability: "stable", version: "v0.1.0",        size: "9.2 KB" },
  { pkg: "@arki/env",   gates: ["ok","ok","ok","ok","ok"], stability: "stable", version: "v0.1.0",        size: "4.3 KB" },
  { pkg: "@arki/db",    gates: ["ok","ok","ok","ok","wip"], stability: "canary", version: "v0.1.0-rc.4", size: "14.4 KB"},
  { pkg: "@arki/kv",    gates: ["ok","ok","ok","ok","ok"], stability: "stable", version: "v0.1.0",        size: "6.1 KB" },
  { pkg: "@arki/queue", gates: ["ok","ok","wip","ok","wip"], stability: "canary", version: "v0.1.0-rc.3", size: "9.7 KB" },
];

function Gate({ name, state }) {
  // state: "ok" | "wip" | "skip"
  const glyph = state === "ok" ? "✓" : state === "wip" ? "○" : "—";
  return (
    <span className={"gate gate-" + state} title={`${name}: ${state === "ok" ? "passing" : state === "wip" ? "in-progress" : "skipped"}`}>
      <span className="gate-glyph">{glyph}</span>
      <span className="gate-name">{name}</span>
    </span>
  );
}

function StabilityTag({ kind }) {
  // kind: "stable" | "canary" | "alpha"
  return <span className={"stab stab-" + kind}>{kind}</span>;
}

function ReleaseGrid({ onSeeAll }) {
  return (
    <section className="release-grid" aria-labelledby="release-grid-h">
      <header className="rg-header">
        <h2 id="release-grid-h" className="rg-h">release status</h2>
        <div className="rg-rule" aria-hidden="true"></div>
        <span className="rg-meta">5 of 25 packages · build 802cf4e</span>
      </header>

      <div className="rg-rows">
        {RELEASE_ROWS.map((row) => (
          <div className="rg-row" key={row.pkg}>
            <div className="rg-pkg">
              <span className="rg-name">{row.pkg}</span>
              <span className="rg-ver">{row.version}</span>
            </div>
            <div className="rg-gates">
              {row.gates.map((g, i) => (
                <Gate key={RELEASE_GATES[i]} name={RELEASE_GATES[i]} state={g} />
              ))}
            </div>
            <div className="rg-trail">
              <span className="rg-size">{row.size}</span>
              <StabilityTag kind={row.stability} />
            </div>
          </div>
        ))}
      </div>

      <footer className="rg-footer">
        <a className="rg-seeall" href="#" onClick={(e) => { e.preventDefault(); onSeeAll && onSeeAll(); }}>
          see all 25 packages <span className="arr">→</span>
        </a>
        <a className="rg-jsonp" href="#">/status.json ↗</a>
      </footer>
    </section>
  );
}

Object.assign(window, { ReleaseGrid });
