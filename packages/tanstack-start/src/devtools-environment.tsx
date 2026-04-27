/**
 * Environment panel for the unified devtools shell.
 *
 * Shows the runtime stats developers actually need at a glance — locale,
 * mode, Sentry status — plus quick actions to verify the error and
 * storage setup without opening DevTools.
 *
 * Lives in `@arki/tanstack-start` so every Start app gets the same panel.
 * Styled with inline tokens (no Tailwind dep) so the panel works even
 * when the app's stylesheet hasn't loaded.
 */
import { type CSSProperties, useEffect, useState } from 'react';

const containerStyle: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontSize: 12,
  lineHeight: 1.5,
  padding: 16,
  color: 'inherit',
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  height: '100%',
  overflow: 'auto',
};

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  opacity: 0.6,
  margin: 0,
};

const rowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '160px 1fr',
  gap: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
};

const rowKeyStyle: CSSProperties = { opacity: 0.6 };

const rowValueStyle: CSSProperties = {
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const buttonRowStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
};

const buttonStyle: CSSProperties = {
  border: '1px solid currentColor',
  borderRadius: 4,
  padding: '4px 10px',
  fontSize: 11,
  fontFamily: 'inherit',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  opacity: 0.85,
};

type Row = { label: string; value: string };

function readEnvironmentRows(now: Date): Row[] {
  const env = (import.meta.env ?? {}) as Record<string, unknown>;
  const isBrowser = typeof window !== 'undefined';

  const docLang = isBrowser ? document.documentElement.lang || '–' : '–';
  const dpr = isBrowser ? `${window.devicePixelRatio}x` : '–';
  const viewport = isBrowser ? `${window.innerWidth}×${window.innerHeight}` : '–';
  const ua = isBrowser ? shortUserAgent(navigator.userAgent) : '–';

  return [
    { label: 'Mode', value: String(env.MODE ?? '–') },
    { label: 'Vite DEV', value: env.DEV ? 'true' : 'false' },
    { label: 'Vite SSR', value: env.SSR ? 'true' : 'false' },
    { label: 'Document language', value: docLang },
    { label: 'Sentry DSN', value: env.VITE_SENTRY_DSN ? 'configured ✓' : 'not set' },
    { label: 'Viewport', value: viewport },
    { label: 'Device pixel ratio', value: dpr },
    { label: 'User agent', value: ua },
    { label: 'Loaded at', value: now.toLocaleTimeString() },
  ];
}

function shortUserAgent(ua: string): string {
  // Pull out the first browser token (e.g. "Chrome/138.0.0.0") for brevity.
  const match = ua.match(/(Firefox|Chrome|Safari|Edg|OPR)\/[\d.]+/);
  return match ? match[0] : ua.slice(0, 40);
}

export function EnvironmentPanel() {
  const [now] = useState(() => new Date());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Re-render once a second so viewport / live values stay current.
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const rows = readEnvironmentRows(now);
  const _ = tick; // dependency anchor for the interval
  void _;

  return (
    <div style={containerStyle}>
      <section style={sectionStyle}>
        <p style={sectionLabelStyle}>Runtime</p>
        {rows.map((row) => (
          <div key={row.label} style={rowStyle}>
            <span style={rowKeyStyle}>{row.label}</span>
            <span style={rowValueStyle} title={row.value}>
              {row.value}
            </span>
          </div>
        ))}
      </section>

      <section style={sectionStyle}>
        <p style={sectionLabelStyle}>Quick actions</p>
        <div style={buttonRowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              throw new Error('Devtools test error — verifying error capture');
            }}
            title="Throws synchronously inside a click handler. Confirms error boundaries + Sentry capture."
          >
            Throw test error
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              setTimeout(() => {
                throw new Error('Devtools async test error — verifying global handler');
              }, 0);
            }}
            title="Throws from a setTimeout callback so window.onerror fires (not a React boundary)."
          >
            Throw async error
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              try {
                localStorage.clear();
                sessionStorage.clear();
                location.reload();
              } catch (err) {
                console.warn('[devtools] clear-storage failed', err);
              }
            }}
            title="Clears localStorage + sessionStorage and reloads."
          >
            Clear storage + reload
          </button>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => {
              try {
                document.cookie.split(';').forEach((c) => {
                  const name = c.split('=')[0]?.trim();
                  if (!name) return;
                  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
                });
                location.reload();
              } catch (err) {
                console.warn('[devtools] clear-cookies failed', err);
              }
            }}
            title="Clears cookies for this origin (path=/) and reloads."
          >
            Clear cookies + reload
          </button>
        </div>
      </section>

      <section style={sectionStyle}>
        <p style={sectionLabelStyle}>Tip</p>
        <p style={{ margin: 0, opacity: 0.7 }}>
          Toggle this panel any time with <kbd>Shift</kbd>+<kbd>Alt</kbd>+<kbd>D</kbd>. Settings
          persist in localStorage.
        </p>
      </section>
    </div>
  );
}
