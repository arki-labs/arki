import { GithubLogo, Moon, Sun } from '@arki/icons/phosphor';
import { useTheme } from '@arki/theme';

const REPO = 'https://github.com/arki-labs/arki';

export function MarketingStatusBar() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <div className="marketing-statusbar" role="contentinfo">
      <div className="grp">
        <span>v0.1.0</span>
        <span className="sep">·</span>
        <span>MIT</span>
        <span className="sep">·</span>
        <span className="pill success">
          <span className="dot" aria-hidden="true" />
          all green
        </span>
      </div>
      <div className="grp">
        <button
          type="button"
          className="marketing-icon-btn"
          aria-label="Toggle theme"
          onClick={() => setTheme(isDark ? 'light' : 'dark')}
        >
          {isDark ? (
            <Sun aria-hidden="true" weight="regular" />
          ) : (
            <Moon aria-hidden="true" weight="regular" />
          )}
        </button>
        <a
          className="marketing-icon-btn"
          aria-label="GitHub"
          href={REPO}
          target="_blank"
          rel="noreferrer"
        >
          <GithubLogo aria-hidden="true" weight="regular" />
        </a>
      </div>
    </div>
  );
}
