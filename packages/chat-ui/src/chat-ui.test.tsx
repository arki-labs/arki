import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { RuntimeUiState } from '@arki/ai';
import { ConnectionLost } from '@arki/ai';

import { AgentStatus } from './agent-status';
import { RuntimeConversation, runtimeStatusToAgentStatus } from './runtime-conversation';
import { createToolRegistry, ToolRegistryProvider, useToolRegistry } from './tool-registry';

describe('runtimeStatusToAgentStatus', () => {
  it('shows executing only while a tool runs', () => {
    expect(runtimeStatusToAgentStatus('running', true)).toBe('executing');
    expect(runtimeStatusToAgentStatus('running', false)).toBe('thinking');
  });

  it('maps the end states and falls back to idle', () => {
    expect(runtimeStatusToAgentStatus('done', false)).toBe('complete');
    expect(runtimeStatusToAgentStatus('error', false)).toBe('error');
    expect(runtimeStatusToAgentStatus('idle', false)).toBe('idle');
  });
});

describe('RuntimeConversation', () => {
  it('shows a failed tool call by its failure message and the run error', () => {
    const state: RuntimeUiState = {
      status: 'error',
      text: '',
      failure: ConnectionLost(),
      toolCalls: [{ tool: 'lookup', status: 'error', error: 'timed out' }],
    };
    const html = renderToStaticMarkup(<RuntimeConversation state={state} />);
    expect(html).toContain('timed out');
    expect(html).toContain(ConnectionLost().message);
  });

  it('hides the status pill on request', () => {
    const state: RuntimeUiState = { status: 'running', text: 'hi', toolCalls: [] };
    const pill = renderToStaticMarkup(<AgentStatus status="thinking" />);
    expect(renderToStaticMarkup(<RuntimeConversation state={state} />)).toContain('chat-agent-status');
    expect(renderToStaticMarkup(<RuntimeConversation state={state} hideStatus />)).not.toContain('chat-agent-status');
    expect(pill).toContain('chat-agent-status');
  });
});

describe('tool registry', () => {
  function Probe() {
    useToolRegistry();
    return null;
  }

  it('throws outside a provider, so a missing provider is never a silent default', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow('ToolRegistryProvider');
  });

  it('returns undefined for a tool with no widget and replaces on register', () => {
    const registry = createToolRegistry({});
    expect(registry.getComponent('search')).toBeUndefined();
    const Widget = () => <p>widget</p>;
    registry.register('search', Widget);
    expect(registry.getComponent('search')).toBe(Widget);
    expect(renderToStaticMarkup(<ToolRegistryProvider registry={registry}>{null}</ToolRegistryProvider>)).toBe('');
  });
});
