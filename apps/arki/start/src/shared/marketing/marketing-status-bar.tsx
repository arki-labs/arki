const REPO = 'https://github.com/arki-dev/arki';

export function MarketingStatusBar() {
  return (
    <div className="marketing-statusbar" role="contentinfo">
      <div className="grp">
        <span>v0.1.0</span>
        <span className="sep">·</span>
        <span>802cf4e</span>
        <span className="sep">·</span>
        <span>MIT</span>
        <span className="sep">·</span>
        <span className="pill success">
          <span className="dot" aria-hidden="true" />
          all green
        </span>
      </div>
      <div className="grp">
        <span>⌘K search</span>
        <span className="sep">·</span>
        <span>⌘/ theme</span>
        <span className="sep">·</span>
        <a href={`${REPO}/blob/main/llms.txt`} target="_blank" rel="noreferrer">
          llms.txt
        </a>
        <span className="sep">·</span>
        <a href="/changelog">changelog</a>
        <span className="sep">·</span>
        <a href={REPO} target="_blank" rel="noreferrer">
          github
        </a>
      </div>
    </div>
  );
}
