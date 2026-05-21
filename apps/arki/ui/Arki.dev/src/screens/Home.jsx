// ────────────────────────────────────────────────────────────────
// 00 — Home  (arki.dev)
//
// Wireframe (per docs/sitemap/00-home.md):
//   nav
//   ── hero: headline · sub · install command · 2 secondary CTAs
//   ── what defineApp looks like (showcase code block)
//   ── doctrine in 4 lines
//   ── release status (compressed) — top 5 × 5 gates
//   ── ASCII band (class D, booting plugin DAG)
//   ── B3 editor-status-bar footer
//
// All visuals lifted from the arki design system (colors_and_type.css
// + app.css). Hero is LEFT-ALIGNED (F-pattern scannability). Single
// accent (amber #facc15) reserved for the primary CTA + the active
// ASCII-band cell — chrome and code blocks stay neutral.
// ────────────────────────────────────────────────────────────────

const { useState, useEffect, useRef } = React;

// ── hero install command (primary CTA) ──────────────────────────
function InstallCommand({ defaultPm = "bun" }) {
  const installs = {
    bun:  "bun add @arki/dot",
    npm:  "npm install @arki/dot",
    pnpm: "pnpm add @arki/dot",
    yarn: "yarn add @arki/dot",
  };
  const [pm, setPm] = useState(defaultPm);
  const [copied, setCopied] = useState(false);

  const doCopy = () => {
    try { navigator.clipboard.writeText(installs[pm]); } catch (e) {}
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="install">
      <div className="install-box">
        <span className="install-prompt" aria-hidden="true">$</span>
        <span className="install-cmd">{installs[pm]}</span>
        <button className={"install-copy" + (copied ? " ok" : "")}
                onClick={doCopy}
                aria-label="Copy install command">
          {copied ? (
            <><i className="ph ph-check" aria-hidden="true"></i>copied</>
          ) : (
            <><i className="ph ph-copy" aria-hidden="true"></i>copy</>
          )}
        </button>
      </div>
      <div className="install-pm" role="tablist" aria-label="package manager">
        {Object.keys(installs).map(k => (
          <button key={k}
                  role="tab"
                  aria-selected={k === pm}
                  className={"install-pm-tab" + (k === pm ? " active" : "")}
                  onClick={() => setPm(k)}>
            {k}
          </button>
        ))}
        <span className="install-pm-meta">v0.1.0 · 9.2 KB · zero deps</span>
      </div>
    </div>
  );
}

// ── secondary CTAs ──────────────────────────────────────────────
function HeroCtas() {
  return (
    <div className="hero-ctas">
      <a className="hero-cta" href="#docs">
        <span className="hero-cta-l">read the docs</span>
        <span className="hero-cta-arr">→</span>
      </a>
      <a className="hero-cta" href="#defineapp">
        <span className="hero-cta-l">see <code className="cmono">defineApp</code></span>
        <span className="hero-cta-arr">→</span>
      </a>
    </div>
  );
}

// ── defineApp showcase ──────────────────────────────────────────
function DefineAppShowcase() {
  // Hand-tinted token spans — `Tk` is provided by primitives.jsx.
  const code = (
    <>
      {Tk.kw("import")}{" { "}{Tk.fn("defineApp")}{" } "}{Tk.kw("from")} {Tk.str("'@arki/dot'")}{";\n"}
      {Tk.kw("import")}{" { "}{Tk.fn("env")}{" } "}{Tk.kw("from")} {Tk.str("'@arki/env/dot'")}{";\n"}
      {Tk.kw("import")}{" { "}{Tk.fn("db")}{"  } "}{Tk.kw("from")} {Tk.str("'@arki/db/dot'")}{";\n"}
      {Tk.kw("import")}{" { "}{Tk.fn("kv")}{"  } "}{Tk.kw("from")} {Tk.str("'@arki/kv/dot'")}{";\n"}
      {Tk.kw("import")}{" { "}{Tk.v("schema")}{", "}{Tk.v("dbSchema")}{" } "}{Tk.kw("from")} {Tk.str("'./schema'")}{";\n\n"}
      {Tk.kw("export const")} {Tk.v("app")}{" = "}{Tk.kw("await")}{" "}{Tk.fn("defineApp")}{"("}{Tk.str("'billing'")}{")\n"}
      {"  ."}{Tk.fn("use")}{"("}{Tk.fn("env")}{"({ schema }))\n"}
      {"  ."}{Tk.fn("use")}{"("}{Tk.fn("db")}{"({ schema: dbSchema }))\n"}
      {"  ."}{Tk.fn("use")}{"("}{Tk.fn("kv")}{"())\n"}
      {"  ."}{Tk.fn("boot")}{"();\n\n"}
      {Tk.com("// type Services = { env: Env<typeof schema>; db: DB<typeof dbSchema>; kv: KV }")}
    </>
  );
  const copyValue =
`import { defineApp } from '@arki/dot';
import { env } from '@arki/env/dot';
import { db }  from '@arki/db/dot';
import { kv }  from '@arki/kv/dot';
import { schema, dbSchema } from './schema';

export const app = await defineApp('billing')
  .use(env({ schema }))
  .use(db({ schema: dbSchema }))
  .use(kv())
  .boot();`;

  return (
    <section className="section" id="defineapp" aria-labelledby="defineapp-h">
      <header className="section-h">
        <h2 id="defineapp-h" className="section-h-t">what <code className="cmono">defineApp</code> looks like</h2>
        <div className="section-h-rule" aria-hidden="true"></div>
        <a className="section-h-link" href="#docs">/docs/concepts/defineApp ↗</a>
      </header>

      <CodeBlock
        filename="src/app.ts"
        code={code}
        copyValue={copyValue}
        provenance={{ label: "fixture · packages/dot/__fixtures__/defineApp.basic.ts" }}
      />
    </section>
  );
}

// ── doctrine in 4 lines ─────────────────────────────────────────
const DOCTRINE = [
  { n: "01", t: "Show, don't promise.",          s: "every claim links to a fixture." },
  { n: "02", t: "Brevity is the brand.",          s: "fewer words. mono labels. no fluff." },
  { n: "03", t: "Agents are first-class readers.",s: "every page humans read has a JSON envelope." },
  { n: "04", t: "The doctrine is visible.",       s: "all of it." , linkLabel: "read /philosophy →", href: "#philosophy" },
];
function Doctrine() {
  return (
    <section className="section section-doctrine" aria-labelledby="doctrine-h">
      <header className="section-h">
        <h2 id="doctrine-h" className="section-h-t">doctrine</h2>
        <div className="section-h-rule" aria-hidden="true"></div>
        <span className="section-h-meta">four binding lines</span>
      </header>

      <ol className="doctrine">
        {DOCTRINE.map(d => (
          <li className="doc-line" key={d.n}>
            <span className="doc-n">{d.n}</span>
            <div className="doc-body">
              <div className="doc-t">{d.t}</div>
              <div className="doc-s">
                {d.s}
                {d.linkLabel && (
                  <> <a className="doc-link" href={d.href}>{d.linkLabel}</a></>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── home composition ────────────────────────────────────────────
function Home({ tweaks = {}, setRoute = () => {} }) {
  return (
    <main className="container home" id="main">
      {/* HERO */}
      <section className="hero-home" aria-labelledby="hero-h">
        <p className="hero-kicker">
          <span className="kicker-dot" aria-hidden="true">●</span>
          <span className="kicker-text">v0.1.0 · public release</span>
          <span className="sep" aria-hidden="true">·</span>
          <a className="kicker-link" href="#changelog">/changelog</a>
        </p>

        <h1 id="hero-h" className="hero-h">
          A TypeScript-first <span className="hero-h-em">application composition</span> framework<span className="hero-dot">.</span>
        </h1>

        <p className="hero-sub">
          Tiny kernel<span className="hero-sub-dot">.</span>{" "}
          Package-owned adapters<span className="hero-sub-dot">.</span>{" "}
          First-class diagnostics<span className="hero-sub-dot">.</span>
        </p>

        <InstallCommand defaultPm={tweaks.defaultPm || "bun"} />

        <HeroCtas />
      </section>

      {/* DEFINEAPP CODE SHOWCASE */}
      <DefineAppShowcase />

      {/* DOCTRINE */}
      <Doctrine />

      {/* RELEASE STATUS (compressed) */}
      <section className="section" id="status" aria-labelledby="status-h">
        <ReleaseGrid onSeeAll={() => setRoute("packages")} />
      </section>
    </main>
  );
}

Object.assign(window, { Home, InstallCommand, HeroCtas, DefineAppShowcase, Doctrine });
