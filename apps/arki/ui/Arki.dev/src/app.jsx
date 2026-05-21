// app.jsx — boots the home page. Wires chrome + Home screen + boot-dag band
// + B3 status bar + tweaks. The page is FIXED to /home; nav links are
// visual-only (with active state) on this single-screen design.

const { useState: useStateApp, useEffect: useEffectApp } = React;

// keep defaults wrapped in EDITMODE markers so the host can persist tweaks.
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "density": "compact",
  "defaultPm": "bun",
  "heroOrder": "install-first",
  "footer": "minimal",
  "band": "boot-dag",
  "bandSpeed": 850,
  "showCodeRain": true
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  // Apply theme + density at the <html> root so CSS variables flip site-wide.
  useEffectApp(() => {
    document.documentElement.dataset.theme   = t.theme;
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.footer  = t.footer;
  }, [t.theme, t.density, t.footer]);

  // Bridge for the design-system Nav (which expects setTheme(next)).
  const setThemeBridge = (next) => setTweak("theme", next);

  return (
    <div className="shell">
      <Nav
        route="home"
        setRoute={() => {}}
        theme={t.theme}
        setTheme={setThemeBridge}
      />

      <div className="body-wrap" data-hero-order={t.heroOrder}>
        <Home tweaks={t} setRoute={() => {}} />
      </div>

      <StatusBar route="home" />

      {/* Selectable bands — default to the spec's class D booting DAG. */}
      {t.band === "boot-dag" && <BandBootDag tickMs={t.bandSpeed} />}
      {t.band === "ascii"    && <ASCIIBand />}
      {t.band === "ticker"   && <BandTicker />}
      {t.band === "graph"    && <BandGraph />}
      {t.band === "monitor"  && <BandMonitor />}
      {t.band === "kinetic"  && <BandKinetic />}
      {t.band === "pipeline" && <BandPipeline />}

      <TweaksPanel title="Tweaks" defaultOpen={false}>
        <TweakSection label="Theme & density" />
        <TweakRadio  label="Theme"   value={t.theme}
                     options={["dark", "light"]}
                     onChange={(v) => setTweak("theme", v)} />
        <TweakRadio  label="Density" value={t.density}
                     options={["dense", "compact", "comfy"]}
                     onChange={(v) => setTweak("density", v)} />
        <TweakRadio  label="Footer"  value={t.footer}
                     options={["minimal", "rich"]}
                     onChange={(v) => setTweak("footer", v)} />

        <TweakSection label="Hero (C2 working assumption)" />
        <TweakSelect label="Hero default pm" value={t.defaultPm}
                     options={["bun", "npm", "pnpm", "yarn"]}
                     onChange={(v) => setTweak("defaultPm", v)} />

        <TweakSection label="ASCII band (C11)" />
        <TweakSelect label="Band variant" value={t.band}
                     options={[
                       "boot-dag",  // class D — spec default
                       "ascii",     // design-system 3-column (wordmark + conveyor + term)
                       "ticker",
                       "graph",
                       "monitor",
                       "kinetic",
                       "pipeline",
                     ]}
                     onChange={(v) => setTweak("band", v)} />
        <TweakSlider label="Boot tick"  value={t.bandSpeed}
                     min={400} max={1600} step={50} unit="ms"
                     onChange={(v) => setTweak("bandSpeed", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
