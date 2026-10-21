import { renderToStaticMarkup } from 'react-dom/server';

import type { RuntimeUiState } from '@arki/ai';
import { RuntimeConversation } from '@arki/chat-ui/runtime-conversation';
import { createToolRegistry, ToolRegistryProvider, useToolRegistry } from '@arki/chat-ui/tool-registry';

// #region run
const state: RuntimeUiState = {
  status: 'running',
  text: 'Looking up the order.',
  toolCalls: [{ tool: 'lookupOrder', status: 'running' }],
};

const html = renderToStaticMarkup(<RuntimeConversation state={state} />);
// #endregion run

// #region registry
function OrderCard({ args }: { args: Record<string, unknown>; result: unknown; status: string }) {
  return <p>Order {String(args.id)}</p>;
}

const registry = createToolRegistry({ lookupOrder: OrderCard });

function ToolView({ toolName }: { toolName: string }) {
  const Component = useToolRegistry().getComponent(toolName);
  return Component ? <Component args={{ id: 7 }} result={null} status="complete" /> : <p>No widget</p>;
}

const widget = renderToStaticMarkup(
  <ToolRegistryProvider registry={registry}>
    <ToolView toolName="lookupOrder" />
  </ToolRegistryProvider>,
);
// #endregion registry

console.log(html.includes('lookupOrder'), html.includes('Looking up the order.'), widget);
