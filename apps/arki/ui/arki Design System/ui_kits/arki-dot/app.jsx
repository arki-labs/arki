// App shell + router

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "band": "ascii",
  "theme": "dark"
}/*EDITMODE-END*/;

function App() {
  const [route, setRoute] = React.useState("home");
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  React.useEffect(() => {
    document.documentElement.setAttribute("data-theme", t.theme);
  }, [t.theme]);

  let Screen;
  switch (route) {
    case "concept":    Screen = Concept;    break;
    case "cli":        Screen = Cli;        break;
    case "packages":   Screen = Packages;   break;
    case "philosophy": Screen = Philosophy; break;
    case "agents":     Screen = AgentsStub; break;
    default:           Screen = Home;
  }

  return (
    <div className="shell">
      <Nav route={route} setRoute={setRoute}
           theme={t.theme}
           setTheme={(v) => setTweak("theme", v)} />
      <Screen setRoute={setRoute} />
      <StatusBar route={route} />
      <Band variant={t.band} />
      <TweaksPanel>
        <TweakSection label="Under-footer band" />
        <TweakSelect
          label="Variant"
          value={t.band}
          options={Object.entries(BANDS).map(([id, b]) => ({ value: id, label: b.label }))}
          onChange={(v) => setTweak("band", v)}
        />
        <TweakSection label="Theme" />
        <TweakRadio
          label="Mode"
          value={t.theme}
          options={["dark", "light"]}
          onChange={(v) => setTweak("theme", v)}
        />
      </TweaksPanel>
    </div>
  );
}

function AgentsStub({ setRoute }) {
  return (
    <main className="container" style={{padding:"64px 0"}}>
      <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--accent)", letterSpacing:"0.06em", textTransform:"uppercase", marginBottom:8}}>
        /agents
      </div>
      <h1 style={{fontSize:36, lineHeight:"44px", fontWeight:600, letterSpacing:"-0.02em", margin:"0 0 16px"}}>
        Recipes for coding agents.
      </h1>
      <p style={{color:"var(--muted-foreground)", fontSize:14, lineHeight:"22px", margin:"0 0 24px", maxWidth:"64ch"}}>
        Every page humans read has a JSON envelope. <code style={{fontFamily:"var(--font-mono)", background:"var(--muted)", padding:"1px 6px", borderRadius:3, color:"var(--foreground)"}}>llms.txt</code> is the index. Below are the most-used task recipes.
      </p>

      <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap: 12, maxWidth: 880}}>
        {[
          ["Add a package",  "Walks an agent from npm install through defineApp().use(...)."],
          ["Diagnose a failure", "dot doctor --json envelope shape, exit codes, fix URLs."],
          ["Inspect the plugin graph", "dot explain --json --graph for static analysis."],
          ["Generate a migration", "dot migrate generate <name> --json envelope."],
        ].map(([t, d]) => (
          <div className="card" key={t}>
            <div style={{fontFamily:"var(--font-mono)", fontSize:11, color:"var(--accent)", marginBottom:4}}>recipe</div>
            <div style={{fontFamily:"var(--font-sans)", fontSize:14, fontWeight:500}}>{t}</div>
            <div style={{fontSize:12, color:"var(--muted-foreground)", marginTop:6, lineHeight:"17px"}}>{d}</div>
          </div>
        ))}
      </div>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
