// Philosophy — /philosophy · reading mode (17/28)

function Philosophy({ setRoute }) {
  return (
    <main className="philosophy">
      <div className="container-rm">
        <div className="kicker">Doctrine · /philosophy</div>
        <h1>The doctrine is visible.</h1>

        <p className="dim">
          The arki public release doctrine, in plain language. Five rules that the
          framework keeps to itself, kept public so the reader can hold us to them.
        </p>

        <div className="pull">A framework that doesn't show its working is a framework that doesn't deserve trust.</div>
        <div className="pull-cite">— public release doctrine §3.1</div>

        <h2>01 — Show, don't promise</h2>
        <p>
          Every public claim is backed by a runnable artifact. <code style={{fontFamily:"var(--font-mono)", fontSize:15, background:"var(--muted)", padding:"1px 6px", borderRadius:3}}>defineApp(...)</code> snippets compile in isolation. <code style={{fontFamily:"var(--font-mono)", fontSize:15, background:"var(--muted)", padding:"1px 6px", borderRadius:3}}>dot doctor --json</code> envelopes are lifted verbatim from CI runs. The
          <code style={{fontFamily:"var(--font-mono)", fontSize:15, background:"var(--muted)", padding:"1px 6px", borderRadius:3}}> npm pack --dry-run</code> output you see on a package page is the literal file list shipped to npm. The site is the contract.
        </p>

        <h2>02 — Brevity is the brand</h2>
        <p>
          Dense, scannable, code-first. The reader is competent. Hero headlines stay under seven words. Concept pages start with runnable code inside the first viewport. We never paraphrase a doc page; we link to it.
        </p>

        <h2>03 — Agents are first-class readers</h2>
        <p>
          Coding agents are <em>not</em> a separate audience. They read what humans read. CLI output ships as both human format and <code style={{fontFamily:"var(--font-mono)", fontSize:15, background:"var(--muted)", padding:"1px 6px", borderRadius:3}}>--json</code> envelope, on the same page. Code blocks have stable anchor IDs so an agent can deep-link.
          <code style={{fontFamily:"var(--font-mono)", fontSize:15, background:"var(--muted)", padding:"1px 6px", borderRadius:3}}> llms.txt </code> is current and linked from the chrome footer.
        </p>

        <h2>04 — Peer respect, not mockery</h2>
        <p>
          AdonisJS, ElysiaJS, Hono, and NestJS are teaching the TypeScript world how to build a framework. We frame differences in terms of jobs-to-be-done, not verdicts. Comparison-shaming reads small; framing reads grown-up. No comparison page that ridicules another framework will ship on arki.dev.
        </p>

        <h2>05 — Documentation is product</h2>
        <p>
          Undocumented public APIs are not public APIs. If a method appears in a release without a doc page, it's a release bug. Tasteful, terse, task-oriented documentation — kept in sync with fixtures tested <em>outside</em> the monorepo — is the difference between a library and a framework.
        </p>
      </div>
    </main>
  );
}

window.Philosophy = Philosophy;
