import { useEffect, useState } from 'react';

type KineticPhrase = {
  lead: string;
  accent: string;
  sub: string;
};

const KINETIC_PHRASES: KineticPhrase[] = [
  { lead: 'ship', accent: 'faster', sub: '9.2 KB kernel · zero deps' },
  { lead: 'build', accent: 'smarter', sub: 'typed plugin graph · structured diagnostics' },
  { lead: 'type', accent: 'safe', sub: 'inference, not plumbing' },
  { lead: 'agent', accent: 'native', sub: 'every page has a JSON envelope' },
  { lead: 'show', accent: "don't promise", sub: 'every claim links to a fixture' },
  { lead: 'peer', accent: 'respect', sub: 'adonis · elysia · hono · different jobs' },
];

const PHRASE_MS = 2800;

export function KineticBand() {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIdx((i) => (i + 1) % KINETIC_PHRASES.length), PHRASE_MS);
    return () => clearInterval(id);
  }, []);

  const phrase = KINETIC_PHRASES[idx];
  if (!phrase) return null;

  return (
    <section className="band band-kinetic" aria-hidden="true">
      <div className="band-side">
        <div className="band-tag">
          {String(idx + 1).padStart(2, '0')} / {String(KINETIC_PHRASES.length).padStart(2, '0')}
        </div>
        <div className="band-title">manifest</div>
        <div className="band-sub">/philosophy</div>
      </div>
      <div className="kin-stage">
        <div className="kin-phrase" key={idx}>
          <span className="kin-lead">{phrase.lead}</span>
          <span className="kin-accent">{phrase.accent}</span>
          <span className="kin-dot">.</span>
        </div>
        <div className="kin-sub" key={`s${idx}`}>
          {phrase.sub}
        </div>
      </div>
      <div className="kin-progress" aria-hidden="true">
        {KINETIC_PHRASES.map((_, i) => (
          <div key={i} className={'kin-tick' + (i === idx ? ' active' : '')} />
        ))}
      </div>
    </section>
  );
}
