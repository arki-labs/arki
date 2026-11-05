// Cross-runtime smoke test. Runs the BUILT entries in headless Chromium via
// `bun run test:runtimes` (the only engine this package claims). Presentational parts are
// mounted in a real DOM and clicked; the parts that need an assistant-ui runtime (thread,
// composer, message, branch picker, action bar, agent panel, markdown message) are loaded,
// and the tool registry is checked for its typed refusal outside a provider.

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

import { ActionBar } from '../dist/src/action-bar.js';
import { AgentPanel } from '../dist/src/agent-panel.js';
import { AgentStatus } from '../dist/src/agent-status.js';
import { ApprovalCard } from '../dist/src/approval-card.js';
import { BranchPicker } from '../dist/src/branch-picker.js';
import { CodeBlock } from '../dist/src/code-block.js';
import { Composer } from '../dist/src/composer.js';
import { MarkdownMessage } from '../dist/src/markdown-message.js';
import { AssistantMessage } from '../dist/src/message.js';
import { RuntimeConversation, runtimeStatusToAgentStatus } from '../dist/src/runtime-conversation.js';
import { StepIndicator } from '../dist/src/step-indicator.js';
import { ThinkingBlock } from '../dist/src/thinking-block.js';
import { ThreadRoot } from '../dist/src/thread.js';
import { ToolCall, ToolCallResult } from '../dist/src/tool-call.js';
import { createToolRegistry, ToolRegistryProvider, useToolRegistry } from '../dist/src/tool-registry.js';

import '../dist/src/types.js';

const mount = element => {
  const host = document.createElement('div');
  document.body.append(host);
  flushSync(() => createRoot(host).render(element));
  return host;
};
const click = (host, text) => {
  const button = [...host.querySelectorAll('button')].find(candidate => candidate.textContent?.includes(text));
  flushSync(() => button?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};

const status = renderToStaticMarkup(createElement(AgentStatus, { status: 'error' }));
const steps = renderToStaticMarkup(
  createElement(StepIndicator, {
    steps: [
      { id: 'a', label: 'Plan', status: 'complete' },
      { id: 'b', label: 'Run', status: 'active' },
    ],
  }),
);
const tool = renderToStaticMarkup(
  createElement(ToolCall, { toolName: 'lookup', status: 'running' }, createElement(ToolCallResult, null, 'found 3')),
);

const decisions = [];
const approval = mount(
  createElement(ApprovalCard, {
    title: 'Send email?',
    description: 'To Ada',
    onAction: result => decisions.push(result),
  }),
);
click(approval, 'Approve');
click(approval, 'Reject');
const feedbackShown = approval.querySelector('[data-slot="chat-approval-feedback"]') !== null;
click(approval, 'Submit Rejection');

const code = mount(createElement(CodeBlock, { code: 'const a = 1;', language: 'ts' }));

const conversation = renderToStaticMarkup(
  createElement(RuntimeConversation, {
    state: {
      status: 'running',
      text: 'hi there',
      toolCalls: [{ tool: 'lookup', status: 'error', error: 'timed out' }],
    },
  }),
);

function Probe() {
  useToolRegistry();
  return null;
}
let outsideProvider;
try {
  renderToStaticMarkup(createElement(Probe));
} catch (error) {
  outsideProvider = error.message;
}
const registry = createToolRegistry({});
const Widget = () => createElement('p', null, 'widget');
registry.register('search', Widget);

const checks = [
  ['agent status shows the error label', status.includes('chat-agent-status') && status.includes('Error'), true],
  ['steps render both labels', steps.includes('Plan') && steps.includes('Run'), true],
  [
    'tool call shows name, running hint and result',
    tool.includes('lookup') && tool.includes('Running...') && tool.includes('found 3'),
    true,
  ],
  ['approve reports the approve action', decisions[0]?.action, 'approve'],
  ['first reject only opens the feedback box', feedbackShown && decisions.length === 2, true],
  ['submitting the rejection reports it', decisions[1]?.action, 'reject'],
  [
    'code block shows the code and language',
    code.textContent.includes('const a = 1;') && code.textContent.includes('ts'),
    true,
  ],
  [
    'runtime conversation shows text and the failed tool message',
    conversation.includes('hi there') && conversation.includes('timed out'),
    true,
  ],
  ['running status with a running tool is executing', runtimeStatusToAgentStatus('running', true), 'executing'],
  ['done status is complete', runtimeStatusToAgentStatus('done', false), 'complete'],
  ['registry outside a provider refuses loudly', outsideProvider?.includes('ToolRegistryProvider'), true],
  [
    'registry finds a registered widget and misses an unknown one',
    registry.getComponent('search') === Widget && registry.getComponent('x') === undefined,
    true,
  ],
  [
    'registry provider renders its children',
    renderToStaticMarkup(createElement(ToolRegistryProvider, { registry }, 'kids')),
    'kids',
  ],
  [
    'runtime-bound parts are exported',
    [ActionBar, AgentPanel, BranchPicker, Composer, MarkdownMessage, AssistantMessage, ThreadRoot, ThinkingBlock].every(
      part => part !== undefined,
    ),
    true,
  ],
];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
