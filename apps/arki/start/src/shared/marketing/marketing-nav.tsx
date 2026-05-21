import { GithubLogo, Moon, Sun } from '@arki/icons/phosphor';
import { useTheme } from '@arki/theme';

import { BrandMark } from './brand-mark';

const REPO = 'https://github.com/arki-labs/arki';

export function MarketingNav() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <nav className="marketing-nav" aria-label="Primary">
      <div className="marketing-nav-left">
        <BrandMark size="nav" />
      </div>
      <div className="marketing-nav-right">
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
    </nav>
  );
}
