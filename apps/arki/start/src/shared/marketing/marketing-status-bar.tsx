import { GithubLogo } from '@arki/icons/phosphor';

const REPO = 'https://github.com/arki-labs/arki';

export function MarketingStatusBar() {
  return (
    <div className="marketing-statusbar" role="contentinfo">
      <div className="grp">
        <span>arki / TypeScript application framework</span>
        <span className="sep">·</span>
        <span>MIT core</span>
      </div>
      <div className="grp">
        <a className="marketing-icon-btn" aria-label="GitHub" href={REPO} target="_blank" rel="noreferrer">
          <GithubLogo aria-hidden="true" weight="regular" />
        </a>
      </div>
    </div>
  );
}
