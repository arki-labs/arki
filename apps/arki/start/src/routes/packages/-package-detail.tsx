import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { DocBody } from '~/features/site-data/doc-body';
import { packageDocHref, packageHref } from '~/features/site-data/package-urls';

import type { getPackageDetailFn } from './-package-data';
import { tierLabel } from './-tiers';

type PackageDetail = NonNullable<Awaited<ReturnType<typeof getPackageDetailFn>>>;
type Section = { detail: PackageDetail };

/** The snapshot folder a version row links to: `next` for the candidate, else the npm version. */
function folderOf(version: PackageDetail['package']['versions'][number]): string {
  return version.channel === 'next' ? 'next' : version.version;
}

/** Page head for a package page: its name and, when the README has one, its purpose line. */
export function packageMeta(detail: PackageDetail | undefined) {
  if (detail === undefined) return {};
  const version = detail.snapshot === null ? '' : `@${detail.snapshot.version}`;
  return { title: `${detail.package.name}${version}`, description: detail.purpose ?? undefined };
}

/** One package page: the latest snapshot or a chosen one. Sections follow the plan's T3.4 list. */
export function PackageDetailPage({ detail }: Section) {
  const { package: entry, snapshot, readme } = detail;
  const breadcrumbs = {
    items: [
      { label: 'Packages', href: '/packages' },
      { label: entry.name, href: packageHref(entry.short) },
    ],
  };

  return (
    <PageContainer breadcrumbs={breadcrumbs}>
      <Shell className="sm:py-8 md:py-12">
        <header>
          <h1>{entry.name}</h1>
          <p>{tierLabel(entry.tier)}</p>
          {detail.purpose !== null && <p>{detail.purpose}</p>}
        </header>
        <VersionPicker detail={detail} />
        <Install detail={detail} />
        {snapshot === null ? (
          <p role="note">No version of this package is on npm or in a release candidate yet, so it has no docs here.</p>
        ) : readme === null ? (
          <p>This version has no README.</p>
        ) : (
          <DocBody html={readme.html} headings={readme.headings} snapshot={snapshot} />
        )}
        <DocList detail={detail} />
        <PublicImports detail={detail} />
        <Runtimes detail={detail} />
        <Examples detail={detail} />
        <Benchmarks detail={detail} />
        <Demos detail={detail} />
        <OpenGaps detail={detail} />
      </Shell>
    </PageContainer>
  );
}

function VersionPicker({ detail }: Section) {
  const { package: entry } = detail;
  if (entry.versions.length === 0) return null;
  return (
    <nav aria-label="Versions">
      <h2>Versions</h2>
      <ul>
        {entry.versions.map(version => {
          const folder = folderOf(version);
          return (
            <li key={folder}>
              <a href={`${packageHref(entry.short)}/${folder}`} aria-current={folder === detail.folder ? 'page' : undefined}>
                {version.version}
              </a>
              {version.channel === 'next' && ' (next: not on npm yet)'}
              {version.archive && ' (archive, not supported)'}
              {version.channel === 'published' && version.version === entry.npmVersion && ' (latest on npm)'}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function Install({ detail }: Section) {
  const { package: entry, snapshot } = detail;
  const viewsOlderVersion = snapshot !== null && snapshot.channel === 'published' && snapshot.version !== entry.npmVersion;
  const target = viewsOlderVersion ? `${entry.name}@${snapshot.version}` : entry.name;
  return (
    <section aria-labelledby="install">
      <h2 id="install">Install</h2>
      {snapshot?.channel === 'next' && <p>Version {snapshot.version} is not on npm yet.</p>}
      {entry.npmVersion === null ? (
        <p>No version is on npm yet.</p>
      ) : (
        <>
          {snapshot?.channel === 'next' && <p>The latest version on npm is {entry.npmVersion}:</p>}
          <pre>
            <code>bun add {target}</code>
          </pre>
        </>
      )}
    </section>
  );
}

function DocList({ detail }: Section) {
  if (detail.folder === null || detail.docs.length === 0) return null;
  const { folder } = detail;
  return (
    <section aria-labelledby="docs">
      <h2 id="docs">Docs</h2>
      <ul>
        {detail.docs.map(doc => (
          <li key={doc.path}>
            <a href={packageDocHref(detail.package.short, folder, doc.path)}>{doc.title}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PublicImports({ detail }: Section) {
  if (detail.snapshot === null) return null;
  const { imports } = detail;
  return (
    <section aria-labelledby="package-public-imports">
      <h2 id="package-public-imports">Public imports</h2>
      {imports === null ? (
        <p>This version has no API index.</p>
      ) : (
        imports.map(row => (
          <div key={row.importPath}>
            <h3>
              <code>{row.importPath}</code>
            </h3>
            {row.groups.map(group => (
              <p key={`${group.kind}:${group.signature}`}>
                {group.count} names of type <code>{group.signature}</code>
              </p>
            ))}
            {row.names.length > 0 && (
              <details>
                <summary>
                  {row.names.length} {row.names.length === 1 ? 'export' : 'exports'}
                </summary>
                <ul>
                  {row.names.map(name => (
                    <li key={name.name}>
                      <code>{name.name}</code> <span>{name.kind}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function Runtimes({ detail }: Section) {
  const engines = Object.entries(detail.snapshot?.engines ?? detail.package.runtimes);
  return (
    <section aria-labelledby="runtimes">
      <h2 id="runtimes">Runtimes</h2>
      {engines.length === 0 ? (
        <p>This version declares no runtime requirements.</p>
      ) : (
        <table>
          <caption>From the engines field of the package manifest.</caption>
          <thead>
            <tr>
              <th scope="col">Runtime</th>
              <th scope="col">Supported versions</th>
            </tr>
          </thead>
          <tbody>
            {engines.map(([runtime, range]) => (
              <tr key={runtime}>
                <th scope="row">{runtime}</th>
                <td>
                  <code>{range}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Examples({ detail }: Section) {
  const report = detail.snapshot?.examples ?? null;
  return (
    <section aria-labelledby="examples">
      <h2 id="examples">Doc examples</h2>
      {report === null ? (
        <p>No example report was recorded for this version.</p>
      ) : (
        <>
          <p>
            {report.compiled} compiled, {report.ran} run, {report.skipped} skipped
            {report.failures.length > 0 && `, ${report.failures.length} failing`}.
          </p>
          {report.skippedBlocks.length > 0 && (
            <details>
              <summary>Why examples were skipped</summary>
              <ul>
                {report.skippedBlocks.map(block => (
                  <li key={`${block.file}:${block.line}`}>
                    <code>{`${block.file}:${block.line}`}</code>: {block.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Benchmarks({ detail }: Section) {
  const status = detail.snapshot?.benchStatus ?? detail.package.benchStatus;
  return (
    <section aria-labelledby="benchmarks">
      <h2 id="benchmarks">Benchmarks</h2>
      <p>
        {status === 'measured'
          ? 'Measured. The README shows the numbers and how they were taken.'
          : 'No benchmarks are published for this version.'}
      </p>
    </section>
  );
}

/** How a demo's pin compares with the newest npm version. Unknown pins are not called out of date. */
function demoLag(pin: string | null, npmVersion: string | null): { text: string; outdated: boolean } {
  if (pin === null) return { text: 'pinned version not found', outdated: false };
  if (npmVersion === null || pin === npmVersion) return { text: `pins ${pin}`, outdated: false };
  return { text: `pins ${pin}, behind ${npmVersion} on npm`, outdated: true };
}

function Demos({ detail }: Section) {
  return (
    <section aria-labelledby="demos">
      <h2 id="demos">Used by demos</h2>
      {detail.demos.length === 0 ? (
        <p>No demo uses this package yet.</p>
      ) : (
        <ul>
          {detail.demos.map(demo => {
            const lag = demoLag(demo.pin, detail.package.npmVersion);
            return (
              <li key={demo.name} data-outdated={lag.outdated || undefined}>
                {demo.repo === null ? demo.name : <a href={`https://github.com/${demo.repo}`}>{demo.name}</a>}:{' '}
                {lag.text}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function OpenGaps({ detail }: Section) {
  const gaps = detail.package.openGaps;
  return (
    <section aria-labelledby="open-gaps">
      <h2 id="open-gaps">Open gaps</h2>
      {gaps.length === 0 ? (
        <p>No open gaps.</p>
      ) : (
        <>
          <p>Release checks this package does not pass yet, and gaps found by the demos:</p>
          <ul>
            {gaps.map(gap => (
              <li key={`${gap.kind}:${gap.foundBy ?? ''}:${gap.title}`}>
                {gap.kind === 'readiness' ? (
                  <code>{gap.title}</code>
                ) : (
                  <>
                    {gap.url === null ? gap.title : <a href={gap.url}>{gap.title}</a>}
                    {gap.url === null ? <> (found-by:{gap.foundBy})</> : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
