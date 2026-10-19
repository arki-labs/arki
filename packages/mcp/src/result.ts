import type { CallToolResult } from '@modelcontextprotocol/server';

import { defineFailure, isFailure } from '@arki/failure';

/** Response exceeds its budget. @fix Request a smaller page. @verify bun run test -- src/orpc.test.ts */
export const ResultTooLarge = defineFailure('mcp.result_too_large', {
  status: 413,
  message: 'The tool result exceeds its budget.',
  remediation: 'Pass limit or cursor to request a smaller result.',
});
/** Response is not JSON. @fix Return a serializable contract output. @verify bun run test -- src/orpc.test.ts */
export const InvalidResult = defineFailure('mcp.internal', {
  status: 500,
  message: 'The tool could not produce a JSON result.',
  remediation: 'Report this tool failure to the application owner.',
});

/** MCP has its own envelope; failures remain model-visible errors. */
export function toolResult(value: unknown, maxChars: number): CallToolResult {
  if (isFailure(value)) {
    const text = `${value.code}: ${value.message}${value.remediation === undefined ? '' : ` ${value.remediation}`}`;
    return { isError: true, content: [{ type: 'text', text }] };
  }
  try {
    const text = jsonText(value);
    if (text === undefined) return toolResult(InvalidResult(), maxChars);
    // A detached JSON snapshot cannot leak prototypes or change after validation.
    const json: unknown = JSON.parse(text);
    const structured = typeof json === 'object' && json !== null && !Array.isArray(json);
    const size = text.length + (structured ? text.length : 0);
    if (size > maxChars) return toolResult(ResultTooLarge(), maxChars);
    return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: json } : {}) };
  } catch {
    return toolResult(InvalidResult(), maxChars);
  }
}

function jsonText(value: unknown): string | undefined {
  return JSON.stringify(value);
}
