// wip-app.jsx — boots the WIP homepage. Reuses design-system Nav,
// StatusBar, ASCII band, and Tweaks. Renders HomeWip in the body.

const { useState: useStateWip, useEffect: useEffectWip } = React;

const WIP_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "density": "compact",
  "footer": "minimal",
  "band": "ascii",
  "bandSpeed": 850,
  "showCommits": true
}/*EDITMODE-END*/;

function WipApp() {
  const [t, setTweak] = useTweaks(WIP_DEFAULTS);

  useEffectWip(() => {
    document.documentElement.dataset.theme   = t.theme;
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.footer  = t.footer;
  }, [t.theme, t.density, t.footer]);

  const setThemeBridge = (next) => setTweak("theme", next);

  return (
    <div className="shell">
      <Nav
        route="home"
        setRoute={() => {}}
        theme={t.theme}
        setTheme={setThemeBridge}
      />

      <div className="body-wrap">
        <HomeWip tweaks={t} setRoute={() => {}} />
      </div>

      <StatusBar route="home" />

      {t.band === "ascii"    && <ASCIIBand />}
      {t.band === "boot-dag" && typeof BandBootDag === "function" && <BandBootDag tickMs={t.bandSpeed} />}
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

        <TweakSection label="ASCII band" />
        <TweakSelect label="Band variant" value={t.band}
                     options={[
                       "ascii",
                       "boot-dag",
                       "ticker",
                       "graph",
                       "monitor",
                       "kinetic",
                       "pipeline",
                     ]}
                     onChange={(v) => setTweak("band", v)} />
        <TweakSlider label="Band speed" value={t.bandSpeed}
                     min={400} max={1600} step={50} unit="ms"
                     onChange={(v) => setTweak("bandSpeed", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<WipApp />);
