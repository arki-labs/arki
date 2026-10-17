/** A public tool name: `<feature>_<name>`, lower-case prefix. The key type of every tool registry. */
export type ToolName = `${Lowercase<string>}_${string}`;

/** What a tool does to the world. Maps to the MCP annotations `readOnlyHint` and `destructiveHint`; `destructive` requires a confirmation. */
export type Effect = 'read' | 'write' | 'destructive';

/** Who may see and call a primitive. Checked at call time and again for `tools/list`. */
export type Access = 'public' | 'user' | { roles?: readonly string[]; scopes?: readonly string[] };
