// ────────────────────────────────────────────────────────────
// 01 — Why ARKI (marketing / doctrine page · priority #4)
//
// The page that converts the skeptical senior developer.
// Long-form, left-aligned, 720px reading-mode column.
//
// Four stacked sections separated by hairline rules:
//   1. The composition problem
//   2. How DOT relates to your current stack    (real <table>)
//   3. When you should NOT pick DOT             (LAW-PRATFALL)
//   4. What you get when DOT fits               + two CTAs
//
// LAW-MENTAL-MODEL — comparison block corrects priors
// LAW-CONFIRMATION-BIAS — Section 3 surfaces disconfirming evidence
// LAW-PRATFALL — admitting limits = perceived credibility
// LAW-AESTHETIC-USABILITY — restrained register at long-form scale
// ────────────────────────────────────────────────────────────

const { useState: useStateWhy } = React;

/* ── peer-framework comparison data ──────────────────── */
const PEERS = [
  {
    name: "AdonisJS",
    role: "node · full-stack",
    summary:
      "Laravel-shaped, opinionated end-to-end, decorator-led — the Node framework for teams that want the Rails bargain.",
    differs: (
      <>
        DOT keeps a tiny kernel and lets <span className="fg">package-owned adapters</span>{" "}
        compose your application. No decorators, no central container — services live in{" "}
        <code>app.services</code>, inferred from your <code>.use()</code> chain.
      </>
    ),
  },
  {
    name: "ElysiaJS",
    role: "bun · http",
    summary:
      "World-class type inference, Bun-native, HTTP-focused — the gold standard for typed routers in the Bun ecosystem.",
    differs: (
      <>
        DOT composes <span className="fg">env + db + kv + queue + RPC + auth</span> — not only
        HTTP routes — and runs the same on Bun, Node, and edge. The HTTP server is one Pip
        among several, not the framework.
      </>
    ),
  },
  {
    name: "Hono",
    role: "multi-runtime · router",
    summary:
      "Tiny, web-standards-first, multi-runtime, beautiful router API — the lean foundation a lot of TypeScript HTTP starts on.",
    differs: (
      <>
        Different layer entirely. DOT composes app <span className="fg">runtimes</span>; Hono
        is the kind of router you register <em>inside</em> a DOT plugin. Use both — they don't
        compete.
      </>
    ),
  },
  {
    name: "NestJS",
    role: "node · enterprise",
    summary:
      "Mature, broad, decorator-led, DI-container heavy — the Angular-shaped backend framework for large enterprise teams.",
    differs: (
      <>
        DOT picks <span className="fg">inference over declaration</span>. No decorator
        theology, no DI container to feed, no module metadata. Services live in{" "}
        <code>app.services</code>, fully typed by the Pip that registered them.
      </>
    ),
  },
  {
    name: "Fastify + hand-glue",
    role: "battle-tested · DIY",
    summary:
      "Battle-tested, fast, flexible — and you bring the cohesion. Most TypeScript backends in production look like a Fastify with a folder of utils around it.",
    differs: (
      <>
        DOT <span className="fg">is</span> the cohesion. The glue between env, db, queue, and
        diagnostics is the framework — not a folder of utils you maintain.
      </>
    ),
  },
];

/* ── Section 3: when NOT to pick DOT ─────────────────── */
const NOT_FOR = [
  {
    body: (
      <>
        <span className="fg">You only need an HTTP router.</span> Use Hono or Elysia
        directly. DOT's composition surface is overhead you don't need.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">You ship to non-TypeScript runtimes</span> (Deno, Go, Python).
        Out of scope. DOT is a TypeScript-first framework — that's the bargain.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">You want decorators as the primary programming model.</span>{" "}
        DOT rejects that path. <code>@Injectable()</code> is not coming.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">You need a meta-framework for the UI layer.</span> DOT is the{" "}
        <em>runtime</em> layer; pair it with TanStack Start or Next.js for UI.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">You need a CMS or admin scaffold.</span> DOT is composable, not
        opinionated about content. Reach for Payload, Strapi, or Directus instead.
      </>
    ),
  },
];

/* ── Section 4: what you get when DOT fits ───────────── */
const VALUE = [
  {
    body: (
      <>
        <span className="fg">A typed app graph</span> you can inspect at runtime, on the CLI
        via <code>dot explain --graph</code>, and in your editor via <code>app.services</code>.
        One source of truth.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">Diagnostics with stable codes</span>, severities, and remediation
        URLs. <code>dot doctor --json</code> returns an envelope a CI job can grep — and an
        agent can parse.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">Package-owned adapters</span> that install cost-proportionally.
        You pay for what you <code>.use()</code> — no monolith, no kitchen-sink bundle.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">A test harness</span> that boots a real DOT app in memory and
        lets you swap dependencies cleanly. Fixtures over mocks. Real graph, fake edges.
      </>
    ),
  },
  {
    body: (
      <>
        <span className="fg">Agent-native surfaces.</span> <code>llms.txt</code>, JSON
        envelopes, a stable manifest contract — Claude, Cursor, and MCP tools can work with
        your codebase without scraping screenshots.
      </>
    ),
  },
];

/* ── the screen ──────────────────────────────────────── */
function Why() {
  return (
    <main className="why" id="main">
      {/* ─── HERO ─────────────────────────────────────── */}
      <div className="why-col">
        <header className="why-hero">
          <div className="why-kicker">
            <span className="rule"></span>
            <span>01 · marketing · why</span>
          </div>
          <h1>
            Why arki<span className="accent">.</span>dot<span className="accent">.</span>
          </h1>
          <p className="why-subtitle">
            <span className="fg">The honest version.</span> What you give up to use this,
            what you get, and when you should pick something else.
          </p>
          <div className="why-meta">
            <span>5 min read</span>
            <span className="sep">·</span>
            <span><span className="acc">●</span> peer respect, not mockery</span>
            <span className="sep">·</span>
            <a href="#">edit on github ↗</a>
          </div>
        </header>
      </div>

      {/* ─── SECTION 1 — composition ────────────────── */}
      <div className="why-col">
        <section className="s" id="composition" aria-labelledby="s1-h">
          <div className="s-num">
            <span className="ord">§ 01</span>
            <span className="dim">·</span>
            <span>the composition problem</span>
          </div>
          <h2 id="s1-h">Every TypeScript backend eventually composes the same eight things.</h2>

          <p>
            You start with a router. Then you need environment variables. Then a database
            client, a key-value store, a queue, an auth service, an RPC layer, background
            jobs, diagnostics for the lot, and a test harness that knows how to start and
            stop the whole graph cleanly.
          </p>

          <div className="why-callout" role="note" aria-label="The composition string">
            <span className="label">// the composition that every backend eventually grows into</span>
            <span className="acc">env</span>
            <span className="dim"> + </span>
            <span className="acc">db</span>
            <span className="dim"> + </span>
            <span className="acc">kv</span>
            <span className="dim"> + </span>
            <span className="acc">queue</span>
            <span className="dim"> + </span>
            <span className="acc">auth</span>
            <span className="dim"> + </span>
            <span className="acc">RPC</span>
            <span className="dim"> + </span>
            <span className="acc">jobs</span>
            <span className="dim"> + </span>
            <span className="acc">diagnostics</span>
            <span className="dim"> + </span>
            <span className="acc">tests</span>
          </div>

          <p>
            You can wire this by hand. Most teams do. But the glue between these libraries
            is where the bugs live — and the glue rots faster than the libraries it connects.
            DOT exists because that glue is a framework's job, not yours.
          </p>
        </section>
      </div>

      {/* ─── SECTION 2 — peer comparison ────────────── */}
      <div className="why-col">
        <section className="s" id="comparison" aria-labelledby="s2-h">
          <div className="s-num">
            <span className="ord">§ 02</span>
            <span className="dim">·</span>
            <span>how DOT relates to your current stack</span>
          </div>
          <h2 id="s2-h">All five are excellent for the jobs they were built for. DOT does a different job.</h2>

          <p className="dim">
            A neutral, jobs-to-be-done comparison. Each peer gets one summary sentence and
            one "DOT differs:" line — no inferiority framing, no checkbox tables, no benchmarks
            without a fixture.
          </p>

          <table className="why-cmp" aria-label="DOT compared to peer frameworks">
            <caption>
              <span>peer comparison</span>
              <span className="tag-respect">peer respect · spec §5</span>
            </caption>
            <tbody>
              {PEERS.map((p) => (
                <React.Fragment key={p.name}>
                  <tr className="peer">
                    <th scope="row">
                      <span className="name">{p.name}</span>
                      <span className="role">{p.role}</span>
                    </th>
                    <td>{p.summary}</td>
                  </tr>
                  <tr className="diff">
                    <th scope="row">
                      <span className="label">
                        <span className="arr">↳</span> DOT differs
                      </span>
                    </th>
                    <td>{p.differs}</td>
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>

          <p className="why-cmp-coda">
            <span className="fg">All five are excellent</span> for the jobs they were built
            for. DOT does a different job — application composition, not HTTP routing or
            dependency injection.
          </p>
        </section>
      </div>

      {/* ─── SECTION 3 — when NOT to pick DOT ────────── */}
      <div className="why-col">
        <section className="s" id="not-for" aria-labelledby="s3-h">
          <div className="s-num">
            <span className="ord">§ 03</span>
            <span className="dim">·</span>
            <span>when you should NOT pick DOT</span>
            <span className="dim">·</span>
            <span style={{color:"hsl(0 63% 60%)"}}>LAW-PRATFALL</span>
          </div>
          <h2 id="s3-h">Five reasons to use something else. Every one of them is real.</h2>

          <p className="dim">
            We have a checklist for this. If any of these apply, the rest of this page is
            entertainment, not evidence.
          </p>

          <ul className="why-list not" role="list">
            {NOT_FOR.map((item, i) => (
              <li key={i}>
                <span className="gl" aria-hidden="true">✕</span>
                <span className="body">{item.body}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {/* ─── SECTION 4 — what you get when DOT fits ──── */}
      <div className="why-col">
        <section className="s" id="value" aria-labelledby="s4-h">
          <div className="s-num">
            <span className="ord">§ 04</span>
            <span className="dim">·</span>
            <span>what you get when DOT fits</span>
          </div>
          <h2 id="s4-h">Five things you can hold us to.</h2>

          <p className="dim">
            Equal visual weight to Section 3 — by design. Disconfirming evidence and value-add
            evidence are two halves of the same trust contract.
          </p>

          <ul className="why-list fits" role="list">
            {VALUE.map((item, i) => (
              <li key={i}>
                <span className="gl" aria-hidden="true">●</span>
                <span className="body">{item.body}</span>
              </li>
            ))}
          </ul>

          <div className="why-cta-row">
            <a className="why-cta" href="#">
              <span className="arr">→</span>
              <span className="label">Read the philosophy</span>
              <span className="target">/philosophy &nbsp;·&nbsp; 02</span>
            </a>
            <a className="why-cta" href="#">
              <span className="arr">→</span>
              <span className="label">Read the getting started</span>
              <span className="target">/docs/getting-started &nbsp;·&nbsp; 10</span>
            </a>
          </div>
        </section>
      </div>

      {/* ─── tail · doctrine cross-references ────────── */}
      <div className="why-col">
        <div className="why-tail">
          <div className="row">
            <span>spec §4 framework quality bar · §5 peer respect doctrine</span>
            <a href="#">discuss on community ↗</a>
          </div>
        </div>
      </div>
    </main>
  );
}

Object.assign(window, { Why });
