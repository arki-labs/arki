import { packageDocHref, packageHref } from '~/features/site-data/package-urls';
import { CodeBlock, Pill } from '~/shared/site-chrome';

import type { getPackageDetailFn } from './-package-data';
import { STATUS_PILL } from './-package-list';
import {
  bannerOf,
  channelWord,
  demoLag,
  examplePills,
  exportCount,
  failureFile,
  firstNames,
  folderOf,
  gapLine,
  isArchivedOnNpm,
  plural,
  skipSummary,
  snapshotStatus,
  versionLabel,
} from './-package-view';
import { tierLabel } from './-tiers';

type PackageDetail = NonNullable<Awaited<ReturnType<typeof getPackageDetailFn>>>;
type Section = { detail: PackageDetail };

/** Page head for a package page: its name and, when the README has one, its purpose line. */
export function packageMeta(detail: PackageDetail | undefined) {
  if (detail === undefined) return {};
  const version = detail.snapshot === null ? '' : `@${detail.snapshot.version}`;
  return { title: `${detail.package.name}${version}`, description: detail.purpose ?? undefined };
}

/** True when the version on screen is the one `/packages/<name>/api.json` serves. */
function showsLatestApi(detail: PackageDetail): boolean {
  return detail.imports !== null && detail.folder === latestFolder(detail);
}

function latestFolder({ package: entry }: PackageDetail): string | null {
  if (entry.status === 'next') return 'next';
  return entry.status === 'none' ? null : entry.npmVersion;
}

/**
 * One package page: the latest snapshot or a chosen one. `inVersion` is true on `/packages/<name>/<version>`, which
 * adds the version to the breadcrumb.
 */
export function PackageDetailPage({ detail, inVersion }: Section & { inVersion: boolean }) {
  const { package: entry, snapshot, readme } = detail;
  const hasDocs = detail.folder !== null && detail.docs.length > 0;
  const toc = [
    { href: '#install', label: 'Install' },
    { href: `#health-${entry.short}`, label: 'Release health' },
    ...(readme === null ? [] : [{ href: '#readme', label: 'README' }]),
    ...(hasDocs ? [{ href: '#docs', label: 'Docs' }] : []),
    ...(snapshot === null ? [] : [{ href: '#imports', label: 'Public imports' }]),
  ];
  const links = [
    { href: entry.mirror, label: 'GitHub mirror' },
    ...(entry.npmVersion === null ? [] : [{ href: `https://www.npmjs.com/package/${entry.name}`, label: 'npm' }]),
    ...(showsLatestApi(detail) ? [{ href: `${packageHref(entry.short)}/api.json`, label: 'api.json' }] : []),
  ];

  return (
    <main id="content" className="pd-main">
      <div className="has-rail">
        <div className="pd-body">
          <nav aria-label="Breadcrumb" className="mono pd-crumbs">
            <a href="/packages">Packages</a> <span aria-hidden="true">/</span>{' '}
            {inVersion ? <a href={packageHref(entry.short)}>{entry.name}</a> : <span aria-current="page">{entry.name}</span>}
            {inVersion && snapshot !== null && (
              <>
                {' '}
                <span aria-hidden="true">/</span> <span aria-current="page">{snapshot.version}</span>
              </>
            )}
          </nav>
          <Header detail={detail} />
          {snapshot !== null && <BannerNote detail={detail} />}
          <Install detail={detail} />
          <Health detail={detail} />
          {snapshot === null ? (
            <p className="none pd-nodocs" role="note">
              No version of this package is on npm or in a release candidate yet, so it has no docs here.
            </p>
          ) : (
            <>
              <Readme detail={detail} />
              <DocList detail={detail} />
              <PublicImports detail={detail} />
            </>
          )}
        </div>
        <aside className="rail" aria-label="On this page and links">
          <h2>On this page</h2>
          <ul>
            {toc.map(item => (
              <li key={item.href}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
          <h2>Links</h2>
          <ul>
            {links.map(item => (
              <li key={item.href}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </main>
  );
}

function Header({ detail }: Section) {
  const { package: entry, snapshot } = detail;
  const pill = STATUS_PILL[snapshotStatus(snapshot)];
  return (
    <div className="pd-head">
      <div className="pd-title">
        <div className="pd-name">
          <h1 className="mono">{entry.name}</h1>
          <Pill kind={pill.kind} glyph={pill.glyph}>
            {snapshotStatus(snapshot)}
          </Pill>
        </div>
        <p className="sub pd-for">
          {snapshot === null
            ? tierLabel(entry.tier)
            : `for ${entry.name}@${snapshot.version} · ${tierLabel(entry.tier)}${snapshot.license === null ? '' : ` · ${snapshot.license}`}`}
        </p>
        {detail.purpose !== null && <p className="pd-purpose">{detail.purpose}</p>}
      </div>
      <VersionPicker detail={detail} />
    </div>
  );
}

function VersionPicker({ detail }: Section) {
  const { package: entry, snapshot } = detail;
  if (entry.versions.length === 0 || snapshot === null) return null;
  return (
    <details className="vpick">
      <summary className="chip">
        <span className="mono pd-dim">Version</span> <span className="mono">{snapshot.version}</span>{' '}
        <span className="mono pd-dim">{channelWord(entry, snapshot)}</span>{' '}
        <span aria-hidden="true" className="caret">
          ▾
        </span>
      </summary>
      <ul aria-label={`Versions of ${entry.name}`}>
        {entry.versions.map(version => {
          const folder = folderOf(version);
          return (
            <li key={folder}>
              <a href={`${packageHref(entry.short)}/${folder}`} aria-current={folder === detail.folder ? 'page' : undefined}>
                <span className="mono">{version.version}</span>
                <span className="why">{versionLabel(entry, version)}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

function BannerNote({ detail }: Section) {
  const { snapshot } = detail;
  if (snapshot === null) return null;
  const banner = bannerOf(detail.package, snapshot);
  if (banner === null) return null;
  const hasMore = banner.more !== '' || banner.link !== null;
  return (
    <div className={banner.kind === 'muted' ? 'banner bn-muted' : 'banner'} role="note">
      <span className="g" aria-hidden="true">
        {banner.glyph}
      </span>
      <div>
        <p>
          <strong>{banner.title}</strong> {banner.text}
        </p>
        {hasMore && (
          <p className="pd-more">
            {banner.more} {banner.link !== null && <a href={banner.link.href}>{banner.link.label}</a>}
          </p>
        )}
      </div>
    </div>
  );
}

function Install({ detail }: Section) {
  const { package: entry, snapshot } = detail;
  const viewsOlderVersion = snapshot !== null && snapshot.channel === 'published' && snapshot.version !== entry.npmVersion;
  const target = viewsOlderVersion ? `${entry.name}@${snapshot.version}` : entry.name;
  const showsCandidate = snapshot?.channel === 'next';
  return (
    <section className="sec" aria-labelledby="install">
      <h2 id="install">Install</h2>
      {entry.npmVersion === null ? (
        <p className="pd-note">
          {showsCandidate ? `${snapshot.version} is not on npm yet. ` : ''}No version is on npm yet.
        </p>
      ) : (
        <>
          {showsCandidate && (
            <p className="pd-note">
              The latest version on npm is {entry.npmVersion}{' '}
              {isArchivedOnNpm(entry, entry.npmVersion) && (
                <Pill kind="st-muted" glyph="▪">
                  archive, not supported
                </Pill>
              )}
            </p>
          )}
          <CodeBlock code={`bun add ${target}`} label="Install command" copyLabel="Copy install command" />
          <details className="more">
            <summary>Other package managers</summary>
            <CodeBlock
              code={`npm install ${target}\npnpm add ${target}\nyarn add ${target}`}
              label="Install with npm, pnpm or yarn"
              copyLabel="Copy npm, pnpm and yarn commands"
            />
          </details>
        </>
      )}
    </section>
  );
}

function Health({ detail }: Section) {
  const { package: entry, snapshot } = detail;
  return (
    <section className="sec hs" aria-labelledby={`health-${entry.short}`}>
      <h2 id={`health-${entry.short}`}>
        Release health{' '}
        <span className="sub">for {snapshot === null ? entry.name : `${entry.name}@${snapshot.version}`}</span>
      </h2>
      <div className="hgrid">
        <ExamplesPanel detail={detail} />
        <GapsPanel detail={detail} />
        <DemosPanel detail={detail} />
        <RuntimesPanel detail={detail} />
      </div>
    </section>
  );
}

function ExamplesPanel({ detail }: Section) {
  const report = detail.snapshot?.examples ?? null;
  const failures = report === null || detail.snapshot === null
    ? null
    : failureFile(report, detail.package, detail.snapshot, detail.folder);
  return (
    <div className="panel">
      <h3>Doc examples</h3>
      {report === null ? (
        <p className="none">No example report was recorded for this version.</p>
      ) : (
        <>
          <p className="pd-pills">
            {examplePills(report).map(pill => (
              <Pill key={pill.label} kind={pill.kind} glyph={pill.glyph}>
                {pill.label}
              </Pill>
            ))}
          </p>
          {failures !== null && (
            <p className="pd-fail">
              {failures.count === 1 ? 'The one failure is' : `All ${failures.count} failures are`} in{' '}
              {failures.href === null ? (
                <code>{failures.file}</code>
              ) : (
                <a href={failures.href} className="mono">
                  {failures.file}
                </a>
              )}
              .
            </p>
          )}
          {report.skippedBlocks.length > 0 && (
            <details className="more">
              <summary>{skipSummary(report.skipped)}</summary>
              <ul>
                {report.skippedBlocks.map(block => (
                  <li key={`${block.file}:${block.line}`}>
                    <code className="pd-at">{`${block.file}:${block.line}`}</code>
                    <br />
                    <span className="pd-dim">{block.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function GapsPanel({ detail }: Section) {
  const gaps = detail.package.openGaps;
  return (
    <div className="panel">
      <h3>Open gaps</h3>
      {gaps.length === 0 ? (
        <>
          <p className="pd-pills">
            <Pill kind="st-ok" glyph="✓">
              no open gaps
            </Pill>
          </p>
          <p className="pd-dim pd-small">Every release check passes and no demo has reported a gap.</p>
        </>
      ) : (
        <>
          <p className="pd-dim pd-small">{gapLine(gaps)}</p>
          <ul>
            {gaps.map(gap => (
              <li key={`${gap.kind}:${gap.foundBy ?? ''}:${gap.title}`} className="pd-gap">
                <span aria-hidden="true" className="pd-x">
                  ✕
                </span>
                <span>
                  {gap.kind === 'readiness' ? (
                    <>
                      <span className="lbl">check</span>
                      <code>{gap.title}</code>
                    </>
                  ) : (
                    <>
                      {gap.url === null ? gap.title : <a href={gap.url}>{gap.title}</a>}{' '}
                      <span className="mono pd-dim pd-tiny">found by {gap.foundBy}</span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function DemosPanel({ detail }: Section) {
  return (
    <div className="panel">
      <h3>Used by demos</h3>
      {detail.demos.length === 0 ? (
        <p className="none">No demo uses this package yet.</p>
      ) : (
        <ul>
          {detail.demos.map(demo => {
            const lag = demoLag(demo.pin, detail.package.npmVersion);
            return (
              <li key={demo.name} className="pd-demo" data-outdated={lag.outdated || undefined}>
                {demo.repo === null ? (
                  <span className="mono">{demo.name}</span>
                ) : (
                  <a href={`https://github.com/${demo.repo}`} className="mono">
                    {demo.name}
                  </a>
                )}
                <Pill kind={lag.kind} glyph={lag.glyph}>
                  {lag.text}
                </Pill>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function RuntimesPanel({ detail }: Section) {
  const engines = Object.entries(detail.snapshot?.engines ?? detail.package.runtimes);
  const bench = detail.snapshot?.benchStatus ?? detail.package.benchStatus;
  return (
    <div className="panel">
      <h3>Runtimes</h3>
      {engines.length === 0 ? (
        <p className="pd-small">
          No <code>engines</code> field, so no runtime requirement is declared.
        </p>
      ) : (
        <ul>
          {engines.map(([runtime, range]) => (
            <li key={runtime}>
              <span className="mono">{runtime}</span> <code>{range}</code>
            </li>
          ))}
        </ul>
      )}
      <h3 className="pd-gap-top">Benchmarks</h3>
      <p className="pd-small">
        {bench === 'measured'
          ? 'Measured. The README shows the numbers and how they were taken.'
          : 'No benchmarks are published for this version.'}
      </p>
    </div>
  );
}

function Readme({ detail }: Section) {
  return (
    <section className="sec md" aria-labelledby="readme">
      <h2 id="readme">README</h2>
      {detail.readme === null ? (
        <p className="none">This version has no README.</p>
      ) : (
        // Compiled at build time from our own package README by `compileMarkdown`; not user input.
        <div dangerouslySetInnerHTML={{ __html: detail.readme.html }} />
      )}
    </section>
  );
}

function DocList({ detail }: Section) {
  const { folder, snapshot } = detail;
  if (folder === null || detail.docs.length === 0) return null;
  return (
    <section className="sec" aria-labelledby="docs">
      <h2 id="docs">
        Docs <span className="sub">{plural(detail.docs.length, 'page')} in {snapshot.version}</span>
      </h2>
      <ul className="doclist">
        {detail.docs.map(doc => (
          <li key={doc.path}>
            <a href={packageDocHref(detail.package.short, folder, doc.path)}>{doc.title}</a>
            <span className="path">{doc.path}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PublicImports({ detail }: Section) {
  const { imports, snapshot, package: entry } = detail;
  if (snapshot === null) return null;
  const total = imports === null ? 0 : imports.reduce((sum, row) => sum + exportCount(row), 0);
  return (
    <section className="sec" aria-labelledby="imports">
      <h2 id="imports">
        Public imports{' '}
        {imports !== null && (
          <span className="sub">
            {plural(imports.length, 'path')} · {plural(total, 'export')}
          </span>
        )}
      </h2>
      {imports === null ? (
        <p className="none">This version has no API index.</p>
      ) : (
        <>
          <table aria-label={`Public imports of ${entry.name} ${snapshot.version}`} className="cards pd-imports">
            <thead>
              <tr>
                <th scope="col">Import path</th>
                <th scope="col">Exports</th>
                <th scope="col">First names</th>
              </tr>
            </thead>
            <tbody>
              {imports.map(row => (
                <tr key={row.importPath} className="card-row">
                  <th scope="row">
                    <code>{row.importPath}</code>
                  </th>
                  <td className="c-end mono">{plural(exportCount(row), 'export')}</td>
                  <td className="c-full mono pd-names">
                    {firstNames(row)}
                    <details className="more">
                      <summary>All {exportCount(row)} names</summary>
                      <ul>
                        {row.names.map(name => (
                          <li key={name.name}>
                            <code>{name.name}</code> <span className="pd-dim">{name.kind}</span>
                          </li>
                        ))}
                        {row.groups.map(group => (
                          <li key={`${group.kind}:${group.signature}`}>
                            {group.count} names of type <code>{group.signature}</code>
                          </li>
                        ))}
                      </ul>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {showsLatestApi(detail) && (
            <p className="pd-json">
              <a href={`${packageHref(entry.short)}/api.json`}>Every export with its signature, as JSON</a>
            </p>
          )}
        </>
      )}
    </section>
  );
}
