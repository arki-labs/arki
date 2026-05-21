/* eslint-disable */
// Logo explorations for arki.dev and @arki/dot.
// Each component renders ONE artboard's contents.

const INK   = 'var(--ink)';
const PAPER = 'var(--paper)';
const MUTED = 'var(--muted)';
const ACCENT= 'var(--accent)';
const RULE  = 'var(--rule)';

// ─────────────────────────────────────────────────────────────────────────────
// Shared bits

function Plate({ children, dark = false, pad = 64, align = 'center', style }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: dark ? 'var(--ink)' : 'var(--paper)',
        color: dark ? 'var(--paper)' : 'var(--ink)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        padding: pad,
        boxSizing: 'border-box',
        position: 'relative',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Caption({ children }) {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 14,
        left: 18,
        fontFamily: 'var(--mono)',
        fontSize: 11,
        letterSpacing: '0.04em',
        color: 'var(--muted)',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// arki.dev — 1: Pure monospace wordmark, the canonical lockup
function L01_Monomark() {
  return (
    <Plate>
      <div style={{ fontFamily: 'var(--mono)', fontWeight: 500, fontSize: 128, letterSpacing: '-0.02em', lineHeight: 1, display: 'flex', alignItems: 'baseline' }}>
        <span>arki</span>
        <span style={{ color: ACCENT }}>.dev</span>
      </div>
      <Caption>01 · Monospace wordmark</Caption>
    </Plate>
  );
}

// 2: Terminal prompt — ~ $ arki with blinking cursor block
function L02_Prompt() {
  return (
    <Plate dark>
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, fontFamily: 'var(--mono)', fontSize: 96, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
        <span style={{ color: ACCENT }}>~</span>
        <span style={{ color: 'var(--muted-dark)' }}>$</span>
        <span>arki</span>
        <span style={{
          display: 'inline-block',
          width: '0.55em',
          height: '0.88em',
          background: PAPER,
          marginLeft: 2,
          transform: 'translateY(0.04em)',
        }} />
      </div>
      <Caption>02 · Terminal prompt</Caption>
    </Plate>
  );
}

// 3: Arch glyph + wordmark (archē)
function L03_Arch() {
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
          {/* Arch: solid block with semicircular opening */}
          <path d="M10 110 L10 60 A50 50 0 0 1 110 60 L110 110 L88 110 L88 60 A28 28 0 0 0 32 60 L32 110 Z" fill={INK} />
          <circle cx="60" cy="60" r="6" fill={ACCENT} />
        </svg>
        <div style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 116, letterSpacing: '-0.04em', lineHeight: 1 }}>
          arki
        </div>
      </div>
      <Caption>03 · Arch mark (archē)</Caption>
    </Plate>
  );
}

// 4: Brackets — [arki] code block
function L04_Brackets() {
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 132, fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1 }}>
        <span style={{ color: ACCENT, fontWeight: 300 }}>[</span>
        <span style={{ fontWeight: 500, padding: '0 .04em' }}>arki</span>
        <span style={{ color: ACCENT, fontWeight: 300 }}>]</span>
      </div>
      <Caption>04 · Bracketed</Caption>
    </Plate>
  );
}

// 5: Chevron monogram — the "a" sits beside a forward chevron
function L05_Chevron() {
  return (
    <Plate dark>
      <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
        <svg width="120" height="120" viewBox="0 0 120 120" fill="none">
          {/* Solid filled chevron-arch */}
          <path d="M22 22 L60 60 L22 98" stroke={ACCENT} strokeWidth="14" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
          <path d="M62 22 L100 60 L62 98" stroke={PAPER} strokeWidth="14" strokeLinecap="square" strokeLinejoin="miter" fill="none" />
        </svg>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 112, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
          arki
        </div>
      </div>
      <Caption>05 · Chevron pair</Caption>
    </Plate>
  );
}

// 6: Geometric "a" monogram — stacked / pixel-built
function L06_Monogram() {
  // build an 'a' from 5x6 grid of squares
  const u = 18;
  const grid = [
    '.XXXX.',
    'X....X',
    'X....X',
    'XXXXXX',
    'X....X',
    'X....X',
  ];
  // simpler: actually render a custom 'a' mark using paths
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        <svg width="140" height="140" viewBox="0 0 140 140" fill="none">
          {/* Custom 'a' — arch + crossbar */}
          <rect x="10" y="10" width="120" height="120" rx="14" fill={INK} />
          <path d="M40 100 L40 56 A30 30 0 0 1 100 56 L100 100" stroke={PAPER} strokeWidth="12" fill="none" strokeLinecap="square" />
          <rect x="40" y="76" width="60" height="12" fill={PAPER} />
          <rect x="94" y="100" width="12" height="14" fill={ACCENT} />
        </svg>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 108, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
          arki<span style={{ color: MUTED }}>.dev</span>
        </div>
      </div>
      <Caption>06 · "a" monogram</Caption>
    </Plate>
  );
}

// 7: Namespace slash — arki/
function L07_Slash() {
  return (
    <Plate>
      <div style={{ fontFamily: 'var(--display)', fontWeight: 600, fontSize: 156, letterSpacing: '-0.05em', lineHeight: 1, display: 'flex', alignItems: 'baseline' }}>
        <span>arki</span>
        <span style={{ color: ACCENT, fontWeight: 400 }}>/</span>
      </div>
      <Caption>07 · Namespace</Caption>
    </Plate>
  );
}

// 8: Stacked / lockup with tagline
function L08_Lockup() {
  return (
    <Plate align="left" pad={80}>
      <div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 132, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 0.95 }}>
          arki<span style={{ color: ACCENT }}>.</span>dev
        </div>
        <div style={{
          marginTop: 22,
          fontFamily: 'var(--mono)',
          fontSize: 18,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: MUTED,
          borderTop: `1px solid ${RULE}`,
          paddingTop: 14,
          maxWidth: 540,
          display: 'flex',
          justifyContent: 'space-between',
        }}>
          <span>Ship faster.</span>
          <span>Build smarter.</span>
        </div>
      </div>
      <Caption>08 · Lockup with rule</Caption>
    </Plate>
  );
}

// 9: Comment-style — // arki
function L09_Comment() {
  return (
    <Plate>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 124, fontWeight: 400, letterSpacing: '-0.02em', lineHeight: 1, display: 'flex', alignItems: 'baseline', gap: '0.2em' }}>
        <span style={{ color: ACCENT }}>//</span>
        <span style={{ fontWeight: 500 }}>arki</span>
      </div>
      <Caption>09 · Inline comment</Caption>
    </Plate>
  );
}

// 10: Arch icon — minimal line glyph
function L10_LineArch() {
  return (
    <Plate dark>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 28 }}>
        <svg width="180" height="120" viewBox="0 0 180 120" fill="none">
          <path d="M14 110 L14 60 A76 76 0 0 1 166 60 L166 110" stroke={PAPER} strokeWidth="6" fill="none" strokeLinecap="square" />
          <line x1="6" y1="110" x2="174" y2="110" stroke={ACCENT} strokeWidth="6" strokeLinecap="square" />
        </svg>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 60, fontWeight: 500, letterSpacing: '0.3em', textTransform: 'lowercase' }}>
          arki
        </div>
      </div>
      <Caption>10 · Line arch · stacked</Caption>
    </Plate>
  );
}

// 11: Cursor block as the period
function L11_CursorPeriod() {
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'baseline', fontFamily: 'var(--mono)', fontSize: 140, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1 }}>
        <span>arki</span>
        <span style={{ display: 'inline-block', width: '0.32em', height: '0.32em', background: ACCENT, marginLeft: '0.04em', marginRight: '0.04em', transform: 'translateY(-0.04em)' }} />
        <span>dev</span>
      </div>
      <Caption>11 · Block period</Caption>
    </Plate>
  );
}

// 12: Wide horizontal banner (favicon strip + name)
function L12_Banner() {
  return (
    <Plate dark align="left" pad={60}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        <div style={{
          width: 100, height: 100, borderRadius: 4,
          background: ACCENT,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'var(--mono)', fontSize: 72, fontWeight: 600, color: INK, lineHeight: 1,
        }}>
          a
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 68, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
            arki<span style={{ color: 'var(--muted-dark)' }}>.dev</span>
          </div>
          <div style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--muted-dark)' }}>
            developer platform
          </div>
        </div>
      </div>
      <Caption>12 · App-tile lockup</Caption>
    </Plate>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// @arki/dot

// D1 — full namespaced wordmark
function D01_Wordmark() {
  return (
    <Plate>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 96, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1, display: 'flex', alignItems: 'baseline' }}>
        <span style={{ color: MUTED }}>@</span>
        <span>arki</span>
        <span style={{ color: MUTED }}>/</span>
        <span>dot</span>
      </div>
      <Caption>D1 · Package wordmark</Caption>
    </Plate>
  );
}

// D2 — dot as a hero glyph
function D02_HeroDot() {
  return (
    <Plate dark>
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        <div style={{ width: 96, height: 96, borderRadius: '50%', background: ACCENT }} />
        <div style={{ fontFamily: 'var(--mono)', fontSize: 88, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
          <span style={{ color: 'var(--muted-dark)' }}>@arki/</span><span>dot</span>
        </div>
      </div>
      <Caption>D2 · Hero dot</Caption>
    </Plate>
  );
}

// D3 — three dots, "dot" emphasized
function D03_Ellipsis() {
  return (
    <Plate>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, alignItems: 'flex-start' }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: INK }} />
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: INK, opacity: 0.35 }} />
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: ACCENT }} />
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 64, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
          @arki/<span style={{ color: ACCENT }}>dot</span>
        </div>
      </div>
      <Caption>D3 · Node series</Caption>
    </Plate>
  );
}

// D4 — square tile mark, "·" inside
function D04_Tile() {
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        <div style={{
          width: 140, height: 140, borderRadius: 6,
          background: INK,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: ACCENT }} />
        </div>
        <div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 60, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>
            dot
          </div>
          <div style={{ marginTop: 8, fontFamily: 'var(--mono)', fontSize: 14, letterSpacing: '0.16em', textTransform: 'uppercase', color: MUTED }}>
            @arki/dot
          </div>
        </div>
      </div>
      <Caption>D4 · Tile + name</Caption>
    </Plate>
  );
}

// D5 — minimal: literal `.` as the mark
function D05_Period() {
  return (
    <Plate>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, fontFamily: 'var(--mono)', fontSize: 220, fontWeight: 600, lineHeight: 0.8, letterSpacing: '-0.05em' }}>
        <span style={{ color: ACCENT }}>.</span>
        <span style={{ fontSize: 64, lineHeight: 1, paddingBottom: 16, color: MUTED }}>@arki/dot</span>
      </div>
      <Caption>D5 · The period</Caption>
    </Plate>
  );
}

// D6 — stamp / pill badge
function D06_Pill() {
  return (
    <Plate dark>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 14,
        padding: '18px 28px',
        border: `2px solid ${PAPER}`,
        borderRadius: 999,
        fontFamily: 'var(--mono)',
        fontSize: 44,
        fontWeight: 500,
        letterSpacing: '-0.01em',
        lineHeight: 1,
      }}>
        <span style={{ width: 18, height: 18, borderRadius: '50%', background: ACCENT, display: 'inline-block' }} />
        <span style={{ color: 'var(--muted-dark)' }}>@arki/</span>
        <span>dot</span>
      </div>
      <Caption>D6 · Pill badge</Caption>
    </Plate>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover / intro plate

function CoverPlate() {
  return (
    <Plate dark align="left" pad={72}>
      <div style={{ maxWidth: 760 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--muted-dark)', marginBottom: 28 }}>
          identity · v0.1
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 96, fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1 }}>
          arki<span style={{ color: ACCENT }}>.dev</span>
        </div>
        <div style={{ marginTop: 20, fontFamily: 'var(--display)', fontSize: 28, fontWeight: 400, lineHeight: 1.3, color: 'var(--muted-dark)' }}>
          Logo explorations for the platform mark and the <span style={{ color: PAPER }}>@arki/dot</span> sub-package.
        </div>

        <div style={{ marginTop: 56, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 24, fontFamily: 'var(--mono)', fontSize: 14 }}>
          <div>
            <div style={{ color: 'var(--muted-dark)', letterSpacing: '0.16em', textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Tone</div>
            <div style={{ lineHeight: 1.5 }}>CLI-inspired, pragmatic, empowering — "Build what you imagine, faster."</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted-dark)', letterSpacing: '0.16em', textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Type</div>
            <div style={{ lineHeight: 1.5 }}>JetBrains Mono · Space Grotesk</div>
          </div>
          <div>
            <div style={{ color: 'var(--muted-dark)', letterSpacing: '0.16em', textTransform: 'uppercase', fontSize: 11, marginBottom: 8 }}>Palette</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Swatch c="var(--ink)" label="ink" dark />
              <Swatch c="var(--paper)" label="paper" />
              <Swatch c={ACCENT} label="accent" />
            </div>
          </div>
        </div>
      </div>
    </Plate>
  );
}

function Swatch({ c, label, dark }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
      <div style={{ width: 44, height: 44, background: c, borderRadius: 4, border: dark ? '1px solid var(--muted-dark)' : 'none' }} />
      <div style={{ fontSize: 10, color: 'var(--muted-dark)', letterSpacing: '0.1em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expose everything

Object.assign(window, {
  CoverPlate,
  L01_Monomark, L02_Prompt, L03_Arch, L04_Brackets, L05_Chevron, L06_Monogram,
  L07_Slash, L08_Lockup, L09_Comment, L10_LineArch, L11_CursorPeriod, L12_Banner,
  D01_Wordmark, D02_HeroDot, D03_Ellipsis, D04_Tile, D05_Period, D06_Pill,
});
