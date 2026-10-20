import { useState } from 'react';

import { ChatCircle, FileText, FlowArrow } from '@arki/icons/phosphor';

const SCENARIOS = [
  {
    id: 'research',
    label: 'Research brief',
    title: 'A quieter way to work',
    category: 'Product research',
    description: 'A working brief on focus, context, and the tools between them.',
    question: 'What should we build next?',
    sources: [
      { name: 'Customer interviews', detail: '8 conversations · notes', mark: '01' },
      { name: 'Workspace study', detail: 'Research · 12 pages', mark: '02' },
      { name: 'Product signals', detail: 'Usage · sample dataset', mark: '03' },
    ],
    insight: 'Less switching. More continuity.',
    brief:
      'People lose the thread when research, decisions, and follow-up live in separate tools. Keep the source beside the work.',
    next: 'Explore one workspace for collecting evidence and writing the next decision.',
    workflow: ['Collect sources', 'Summarize findings', 'Review the brief'],
    answer:
      'The sample interviews point to context switching as the recurring problem. Test a shared research workspace before adding more standalone tools.',
    reference: 'Customer interviews · Workspace study',
  },
  {
    id: 'support',
    label: 'Support reply',
    title: 'A useful first response',
    category: 'Customer support',
    description: 'Bring the request, the policy, and the response into one place.',
    question: 'How should we reply?',
    sources: [
      { name: 'Customer request', detail: 'Ticket #1042 · sample', mark: '01' },
      { name: 'Returns policy', detail: 'Handbook · 2 pages', mark: '02' },
      { name: 'Order history', detail: 'Order #208 · sample', mark: '03' },
    ],
    insight: 'Resolve the question. Keep the context.',
    brief:
      'A customer received the wrong item. The sample policy allows a replacement, and the order record contains the original selection.',
    next: 'Prepare a replacement offer for a teammate to review before sending.',
    workflow: ['Collect the request', 'Summarize the policy', 'Review the reply'],
    answer:
      'Thanks for flagging the incorrect item. We can arrange a replacement for your original selection. Please confirm the delivery address so the team can help.',
    reference: 'Customer request · Returns policy',
  },
  {
    id: 'invoice',
    label: 'Invoice review',
    title: 'Every line accounted for',
    category: 'Finance operations',
    description: 'Review an invoice alongside the records that explain it.',
    question: 'Is this invoice ready for approval?',
    sources: [
      { name: 'October invoice', detail: 'Invoice #028 · sample', mark: '01' },
      { name: 'Purchase order', detail: 'PO #016 · sample', mark: '02' },
      { name: 'Delivery record', detail: 'Receiving · sample', mark: '03' },
    ],
    insight: 'One mismatch. A clear next step.',
    brief:
      'The sample invoice lists 24 units. The purchase order and delivery record both list 20. The remaining lines match.',
    next: 'Ask the supplier to correct the quantity before approving payment.',
    workflow: ['Collect the records', 'Summarize differences', 'Review for approval'],
    answer:
      'Hold this sample invoice for review. The billed quantity exceeds the received quantity by four units. Ask the supplier for a corrected invoice.',
    reference: 'October invoice · Delivery record',
  },
] as const;

const VIEWS = [
  { id: 'research', label: 'Research', icon: FileText },
  { id: 'workflow', label: 'Workflow', icon: FlowArrow },
  { id: 'assistant', label: 'Assistant', icon: ChatCircle },
] as const;

const INSPECTORS = ['Composition', 'Graph'] as const;

// Excerpt from packages/dot/README.md, “Quick start”. Plugin definitions are in the source.
const COMPOSITION = `import { defineApp } from '@arki/dot';

const app = await defineApp('acme')
  .use(dbPlugin)
  .use(billingPlugin)
  .start();`;

export function AppPreview() {
  const [scenario, setScenario] = useState<(typeof SCENARIOS)[number]>(SCENARIOS[0]);
  const [view, setView] = useState<(typeof VIEWS)[number]['id']>('research');
  const [inspector, setInspector] = useState<(typeof INSPECTORS)[number]>('Composition');
  const [showAnswer, setShowAnswer] = useState(false);

  return (
    <section id="app-preview" className="demo" aria-label="Explore an Arki application concept">
      <div className="demo-caption">
        <span>
          <span className="demo-status-dot" aria-hidden="true" />
          Application preview · sample data
        </span>
        <span className="demo-connection">interface ↔ execution</span>
      </div>
      <div className="demo-scenarios" aria-label="Choose a sample scenario">
        {SCENARIOS.map(item => (
          <button
            key={item.id}
            type="button"
            aria-pressed={scenario.id === item.id}
            onClick={() => {
              setScenario(item);
              setShowAnswer(false);
            }}
          >
            {item.label}
            <span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
      <div className="demo-panels">
        <div className="demo-workspace">
          <header className="demo-appbar">
            <span className="demo-appname">
              <span className="demo-appmark" aria-hidden="true">
                f.
              </span>
              Fieldnotes
            </span>
            <span className="demo-workspace-label">Personal workspace</span>
            <span className="demo-avatar" aria-label="Sample user Alex">
              A
            </span>
          </header>
          <div className="demo-appbody">
            <nav className="demo-nav" aria-label="Preview workspace">
              <span className="demo-nav-label">WORKSPACE</span>
              {VIEWS.map(item => (
                <button key={item.id} type="button" aria-pressed={view === item.id} onClick={() => setView(item.id)}>
                  <span className="demo-nav-glyph" aria-hidden="true">
                    <item.icon weight="regular" />
                  </span>
                  {item.label}
                  {view === item.id && (
                    <span className="demo-nav-current" aria-hidden="true">
                      ·
                    </span>
                  )}
                </button>
              ))}
              <div className="demo-nav-foot">
                <span aria-hidden="true">○</span> A space for the work.
              </div>
            </nav>
            <div className="demo-document" aria-live="polite">
              <div className="demo-breadcrumb">
                {scenario.category}
                <span aria-hidden="true">/</span>
                {VIEWS.find(item => item.id === view)?.label}
              </div>
              <h2>{scenario.title}</h2>
              <p className="demo-description">{scenario.description}</p>
              {view === 'research' && (
                <>
                  <div className="demo-section-label">
                    SOURCES <span>{scenario.sources.length.toString().padStart(2, '0')}</span>
                  </div>
                  <ul className="demo-sources">
                    {scenario.sources.map(source => (
                      <li key={source.name}>
                        <span className="demo-source-mark" aria-hidden="true">
                          {source.mark}
                        </span>
                        <div>
                          <strong>{source.name}</strong>
                          <span>{source.detail}</span>
                        </div>
                        <span className="demo-source-check" aria-label="Included">
                          ✓
                        </span>
                      </li>
                    ))}
                  </ul>
                  <article className="demo-brief">
                    <div className="demo-section-label">WORKING BRIEF</div>
                    <h3>{scenario.insight}</h3>
                    <p>{scenario.brief}</p>
                    <div className="demo-next">
                      <span>Next step</span>
                      {scenario.next}
                    </div>
                  </article>
                </>
              )}
              {view === 'workflow' && (
                <div className="demo-workflow">
                  <div className="demo-section-label">A REVIEWABLE PROCESS</div>
                  <ol>
                    {scenario.workflow.map((step, index) => (
                      <li key={step}>
                        <span className="demo-step-number">0{index + 1}</span>
                        <div>
                          <strong>{step}</strong>
                          <p>
                            {index === 0
                              ? 'Keep the original evidence.'
                              : index === 1
                                ? 'Make the reasoning visible.'
                                : 'A person makes the final call.'}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  <p className="demo-footnote">Conceptual workflow · no jobs are running.</p>
                </div>
              )}
              {view === 'assistant' && (
                <div className="demo-assistant">
                  <div className="demo-section-label">ASSISTANT PREVIEW</div>
                  <p className="demo-question">{scenario.question}</p>
                  {showAnswer ? (
                    <div className="demo-answer">
                      <span className="demo-answer-label">Sample answer</span>
                      <p>{scenario.answer}</p>
                      <span className="demo-citation">Sources: {scenario.reference}</span>
                    </div>
                  ) : (
                    <p className="demo-answer-empty">See how an answer can stay connected to its sources.</p>
                  )}
                  <button type="button" className="demo-answer-button" onClick={() => setShowAnswer(!showAnswer)}>
                    {showAnswer ? 'Reset preview' : 'Preview answer'}
                    <span aria-hidden="true">{showAnswer ? '↺' : '↗'}</span>
                  </button>
                  <p className="demo-footnote">Predefined sample response. No model or API call.</p>
                </div>
              )}
            </div>
          </div>
          <footer className="demo-appfooter">
            <span>Local interaction</span>
            <span>
              Concept preview <span aria-hidden="true">↗</span>
            </span>
          </footer>
        </div>
        <aside className="demo-inspector" aria-label="Application structure inspector">
          <div className="demo-inspector-header">
            <span className="demo-section-label">UNDER THE SURFACE</span>
            <span aria-hidden="true">{'{ }'}</span>
          </div>
          <div className="demo-inspector-tabs" aria-label="Inspector view">
            {INSPECTORS.map(item => (
              <button type="button" key={item} aria-pressed={inspector === item} onClick={() => setInspector(item)}>
                {item}
              </button>
            ))}
          </div>
          {inspector === 'Composition' ? (
            <div className="demo-inspector-content">
              <div className="demo-file">
                <span aria-hidden="true">▤</span> app.ts <span>TypeScript</span>
              </div>
              <pre className="demo-code">
                <code>{COMPOSITION}</code>
              </pre>
              <div className="demo-code-caption">
                <span className="demo-section-label">DOT COMPOSITION EXAMPLE</span>
                <p>Explicit plugins. One application lifecycle. The compiler reads the chain.</p>
                <p className="demo-footnote">
                  Excerpt; plugin definitions are in the source. This is a DOT example, separate from the interface
                  concept.
                </p>
                <a
                  href="https://github.com/arki-labs/arki/blob/HEAD/packages/dot/README.md#quick-start"
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the source example <span aria-hidden="true">↗</span>
                </a>
              </div>
            </div>
          ) : (
            <div className="demo-inspector-content demo-graph-content">
              <div className="demo-section-label">CONCEPTUAL APPLICATION STRUCTURE</div>
              <div className="demo-graph">
                <div className="demo-graph-node demo-graph-root">
                  Fieldnotes<span>interface</span>
                </div>
                <span className="demo-graph-edge" aria-hidden="true">
                  │
                </span>
                <div className="demo-graph-node">
                  Application<span>composition & lifecycle</span>
                </div>
                <span className="demo-graph-edge" aria-hidden="true">
                  │
                </span>
                <div className="demo-graph-leaves">
                  <div className="demo-graph-node">Sources</div>
                  <div className="demo-graph-node">Workflow</div>
                  <div className="demo-graph-node">Assistant</div>
                </div>
              </div>
              <p className="demo-footnote">
                A relationship map for this concept. It does not represent shipped Arki integrations.
              </p>
            </div>
          )}
          <div className="demo-inspector-footer">
            <span aria-hidden="true">↳</span> Different views. One application.
          </div>
        </aside>
      </div>
    </section>
  );
}
