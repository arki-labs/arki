import { GithubLogo, MagnifyingGlass, Moon, Sun } from '@arki/icons/phosphor';
import { useTheme } from '@arki/theme';

const NAV_LINKS = [
  { href: '/docs', label: 'Docs' },
  { href: '/packages', label: 'Packages' },
  { href: '/cli', label: 'CLI' },
  { href: '/agents', label: 'Agents' },
  { href: '/why', label: 'Why' },
];

const REPO = 'https://github.com/arki-dev/arki';

type Props = {
  activeHref?: string;
};

export function MarketingNav({ activeHref }: Readonly<Props>) {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';

  return (
    <nav className="marketing-nav" aria-label="Primary">
      <div className="marketing-nav-left">
        <a href="/" className="marketing-nav-mark">
          arki<span className="accent">.</span>
          <span className="dim">dot</span>
        </a>
        <div className="marketing-nav-links">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={'marketing-nav-link' + (activeHref === l.href ? ' active' : '')}
            >
              {l.label}
            </a>
          ))}
        </div>
      </div>
      <div className="marketing-nav-right">
        <div className="marketing-cmdk" role="search">
          <MagnifyingGlass aria-hidden="true" weight="regular" style={{ fontSize: 14 }} />
          <span>Search docs, packages…</span>
          <span className="kbd">⌘K</span>
        </div>
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
