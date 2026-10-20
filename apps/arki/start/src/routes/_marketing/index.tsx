import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';

import { ArrowDown, ArrowRight, ArrowUpRight, Check, Copy, GithubLogo, Moon, Sun } from '@arki/icons/phosphor';
import { useTheme } from '@arki/theme';

import { getDefaultMeta } from '~/shared-metadata';
import { AppPreview } from '~/shared/marketing/app-preview';
import appPreviewCss from '~/styles/app-preview.css?url';
import homeCss from '~/styles/home.css?url';

const REPO = 'https://github.com/arki-labs/arki';
const DOT_DOCS = REPO + '/blob/HEAD/packages/dot/README.md';
const INSTALLS = [
  { name: 'bun', command: 'bun add @arki/dot' },
  { name: 'npm', command: 'npm install @arki/dot' },
  { name: 'pnpm', command: 'pnpm add @arki/dot' },
  { name: 'yarn', command: 'yarn add @arki/dot' },
] as const;

const PRINCIPLES = [
  {
    number: '01',
    title: 'Define once. Infer everywhere.',
    text: 'Inputs, outputs and failures have one source. Carry the same contract through the application.',
    detail: 'One contract / every boundary',
  },
  {
    number: '02',
    title: 'The application can explain itself.',
    text: 'Humans and agents should read the same capabilities, dependencies and failure contracts.',
    detail: 'Readable by humans / inspectable by agents',
  },
  {
    number: '03',
    title: 'Work has boundaries.',
    text: 'Make permissions, failures and resource limits explicit. An agent choosing a tool grants no authority.',
    detail: 'Explicit authority / bounded work',
  },
  {
    number: '04',
    title: 'Business truth survives interruptions.',
    text: 'Keep durable records. Reconcile uncertain effects before retrying them.',
    detail: 'Observe / recover / verify',
  },
] as const;

export const Route = createFileRoute('/_marketing/')({
  head: () => {
    const base = getDefaultMeta({
      title: 'arki — One app. Every moving part.',
      description:
        'A TypeScript application framework for agents, workflows and AI products. Explore the application, the composition model and the principles behind Arki.',
    });
    return {
      ...base,
      links: [...base.links, { rel: 'stylesheet', href: homeCss }, { rel: 'stylesheet', href: appPreviewCss }],
    };
  },
  component: HomePage,
});

function Wordmark() {
  return (
    <span className="home-wordmark">
      <span className="home-mark" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </span>
      arki<span className="home-wordmark-dot">.</span>
    </span>
  );
}

function InstallCommand() {
  const [manager, setManager] = useState<(typeof INSTALLS)[number]>(INSTALLS[0]);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(manager.command);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="home-install">
      <div className="home-install-command">
        <span aria-hidden="true">$</span>
        <code>{manager.command}</code>
        <button
          type="button"
          onClick={() => void copyCommand()}
          aria-label={copyState === 'copied' ? 'Install command copied' : 'Copy install command'}
        >
          {copyState === 'copied' ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      <div className="home-install-meta">
        <div className="home-managers" role="group" aria-label="Package manager">
          {INSTALLS.map(item => (
            <button
              type="button"
              key={item.name}
              aria-pressed={manager.name === item.name}
              onClick={() => {
                setManager(item);
                setCopyState('idle');
              }}
            >
              {item.name}
            </button>
          ))}
        </div>
        <span className="home-copy-status" role="status">
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Select the command to copy'
              : 'Start with the kernel'}
        </span>
      </div>
    </div>
  );
}

function HomePage() {
  const { resolvedTheme, setTheme } = useTheme();
  const dark = resolvedTheme === 'dark';

  return (
    <div className="home" id="top">
      <a className="home-skip" href="#framework">
        Skip to content
      </a>
      <header className="home-header home-container">
        <a className="home-brand" href="#top" aria-label="arki home">
          <Wordmark />
        </a>
        <nav className="home-nav" aria-label="Main navigation">
          <a href="#framework">Framework</a>
          <a href="#app-preview">The app</a>
          <a href="#principles">Principles</a>
        </nav>
        <div className="home-header-actions">
          <button
            className="home-theme"
            type="button"
            aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={() => setTheme(dark ? 'light' : 'dark')}
          >
            {dark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
          </button>
          <a className="home-github" href={REPO} target="_blank" rel="noreferrer">
            <GithubLogo aria-hidden="true" />
            <span>GitHub</span>
            <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </header>
      <section className="home-hero home-container" id="framework" aria-labelledby="home-title">
        <div className="home-eyebrow">
          <span className="home-signal" aria-hidden="true" /> The TypeScript application framework
        </div>
        <div className="home-hero-grid">
          <h1 id="home-title">
            One app.
            <br />
            Every moving part<span className="home-period">.</span>
          </h1>
          <div className="home-hero-aside">
            <p className="home-intro">
              The interface. The agent.
              <br />
              The work behind it.
            </p>
            <p className="home-description">
              Arki brings them into one TypeScript application. Built for agents, workflows and AI products. On
              infrastructure you choose.
            </p>
            <a className="home-button home-button-primary" href="#app-preview">
              Explore the application <ArrowDown aria-hidden="true" />
            </a>
            <InstallCommand />
          </div>
        </div>
        <div className="home-hero-foot">
          <span>Independent packages. One composition model.</span>
          <a href={DOT_DOCS} target="_blank" rel="noreferrer">
            Read the DOT documentation <ArrowUpRight aria-hidden="true" />
          </a>
        </div>
      </section>
      <div className="home-container home-preview-wrap">
        <AppPreview />
      </div>
      <section className="home-stack home-container" aria-label="The supported application stack">
        <span className="home-label">
          Familiar tools.
          <br />A shared foundation.
        </span>
        <ul>
          {['TanStack Start', 'oRPC', 'Drizzle', 'Postgres', 'Better Auth'].map(name => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>
      <section className="home-contract home-container" aria-labelledby="contract-title">
        <div className="home-section-heading">
          <span className="home-label">01 / The connective tissue</span>
          <h2 id="contract-title">
            One definition.
            <br />
            All the way through.
          </h2>
          <p>
            Define the contract at its source. Infer it wherever the application needs it. That is the principle behind
            the stack.
          </p>
        </div>
        <div
          className="home-contract-track"
          aria-label="One source contract connects database, API, jobs, agent tools and interface"
        >
          <div className="home-contract-source">
            <span className="home-label">The source</span>
            <code>input · output · failure</code>
            <span>Defined once</span>
          </div>
          <div className="home-contract-branches">
            {[
              ['01', 'Database', 'Persist the same domain values.'],
              ['02', 'API', 'Validate at the boundary.'],
              ['03', 'Jobs', 'Carry the execution contract.'],
              ['04', 'Agent tools', 'Share logic. Set authority.'],
              ['05', 'Interface', 'Use the inferred result.'],
            ].map(([number, label, description]) => (
              <div className="home-contract-row" key={number}>
                <span>{number}</span>
                <strong>{label}</strong>
                <span>{description}</span>
                <ArrowRight aria-hidden="true" />
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="home-principles home-container" id="principles" aria-labelledby="principles-title">
        <div className="home-section-heading">
          <span className="home-label">02 / Principles, in the open</span>
          <h2 id="principles-title">
            Designed to be
            <br />
            understood.
          </h2>
          <p>
            These are the framework’s design requirements. Implementation is in progress; a principle is a commitment,
            not a release badge.
          </p>
        </div>
        <div className="home-principle-list">
          {PRINCIPLES.map(principle => (
            <article key={principle.number}>
              <span className="home-principle-number">{principle.number}</span>
              <div>
                <h3>{principle.title}</h3>
                <p>{principle.text}</p>
                <span className="home-label">{principle.detail}</span>
              </div>
            </article>
          ))}
        </div>
      </section>
      <section className="home-offer home-container" id="open-source" aria-labelledby="offer-title">
        <div className="home-offer-intro">
          <span className="home-label">03 / Start with the foundation</span>
          <h2 id="offer-title">
            Your app.
            <br />
            Your source.
            <br />
            <span>Your next idea.</span>
          </h2>
          <p>Use the framework. Keep control of the application.</p>
        </div>
        <div className="home-offer-options">
          <article>
            <div className="home-offer-label">
              <span className="home-label">Open source core</span>
              <span className="home-license">MIT</span>
            </div>
            <h3>The framework.</h3>
            <p>
              Start with DOT and adopt the packages your application needs. Read the APIs, examples and runtime
              requirements in the source.
            </p>
            <a className="home-text-link" href={DOT_DOCS} target="_blank" rel="noreferrer">
              Explore the framework <ArrowUpRight aria-hidden="true" />
            </a>
          </article>
          <article>
            <div className="home-offer-label">
              <span className="home-label">SaaS source licence</span>
              <span className="home-planned">Planned</span>
            </div>
            <h3>The finished workflows.</h3>
            <p>
              Workspace onboarding, subscriptions and operator screens, with source and upgrade guidance. Planned as an
              annual licence.
            </p>
            <span className="home-offer-note">In development. Release details will follow.</span>
          </article>
        </div>
      </section>
      <footer className="home-footer home-container">
        <a className="home-brand" href="#top" aria-label="arki home">
          <Wordmark />
        </a>
        <p>
          Compose the application.
          <br />
          Understand every moving part.
        </p>
        <a href={REPO} target="_blank" rel="noreferrer">
          Read the source <ArrowUpRight aria-hidden="true" />
        </a>
      </footer>
    </div>
  );
}
