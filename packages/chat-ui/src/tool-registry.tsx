'use client';

import * as React from 'react';

type ToolComponent = React.ComponentType<{
  args: Record<string, unknown>;
  result: unknown;
  status: 'pending' | 'running' | 'complete' | 'error';
}>;

type ToolRegistryContextValue = {
  getComponent: (toolName: string) => ToolComponent | undefined;
  register: (toolName: string, component: ToolComponent) => void;
}

const ToolRegistryContext = React.createContext<ToolRegistryContextValue | null>(null);

/**
 * Creates a tool registry — a mapping of tool names to React components.
 *
 * This is the "Generative UI" pattern: when the agent calls a tool,
 * the UI renders a purpose-built widget instead of raw JSON.
 *
 * @example
 * ```tsx
 * const registry = createToolRegistry({
 *   getWeather: WeatherWidget,
 *   searchFlights: FlightResultsCard,
 *   calculateMortgage: MortgageCalculator,
 * });
 *
 * <ToolRegistryProvider registry={registry}>
 *   <Thread runtime={runtime} />
 * </ToolRegistryProvider>
 * ```
 */
function createToolRegistry(tools: Record<string, ToolComponent>): ToolRegistryContextValue {
  const registry = new Map(Object.entries(tools));

  return {
    getComponent: (toolName: string) => registry.get(toolName),
    register: (toolName: string, component: ToolComponent) => {
      registry.set(toolName, component);
    },
  };
}

function ToolRegistryProvider({
  registry,
  children,
}: {
  registry: ToolRegistryContextValue;
  children: React.ReactNode;
}) {
  return <ToolRegistryContext.Provider value={registry}>{children}</ToolRegistryContext.Provider>;
}

/**
 * Access the tool registry to resolve tool names to components.
 *
 * @example
 * ```tsx
 * function ToolCallRenderer({ toolName, args, result, status }) {
 *   const { getComponent } = useToolRegistry();
 *   const Component = getComponent(toolName);
 *   if (Component) return <Component args={args} result={result} status={status} />;
 *   return <ToolCall toolName={toolName} status={status} />;
 * }
 * ```
 */
function useToolRegistry(): ToolRegistryContextValue {
  const context = React.useContext(ToolRegistryContext);
  if (!context) {
    throw new Error('useToolRegistry must be used within a ToolRegistryProvider');
  }
  return context;
}

export { createToolRegistry, ToolRegistryProvider, useToolRegistry, type ToolComponent };
