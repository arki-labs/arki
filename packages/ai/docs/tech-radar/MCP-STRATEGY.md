# MCP Strategy — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. MCP Ecosystem Status (Feb 2026)

The Model Context Protocol has reached critical mass:

| Metric | Value |
|--------|-------|
| Total downloads | 50M+ |
| Available servers | 5,800+ |
| Available clients | 300+ |
| Spec version | 2025-06-18 (stable) |
| Auth standard | OAuth 2.1 (production-ready) |
| Transport | Streamable HTTP (replacing SSE) |

MCP has become the de facto standard for AI tool integration. Claude Desktop, Cursor, Windsurf, VS Code Copilot, and most AI assistants now support MCP natively. This creates a massive distribution channel for Avocabo.

---

## 2. Avocabo as MCP Server

Exposing Avocabo's intelligence as an MCP server lets **any MCP client** query a user's content library. This is the "Your knowledge, anywhere AI lives" wow factor.

### Proposed Endpoints

| Tool Name | Description | Lane | Auth |
|-----------|-------------|------|------|
| `avocabo_search` | Semantic search across user's content library | 2 | OAuth |
| `avocabo_summarize` | Summarize a specific item or topic cluster | 2 | OAuth |
| `avocabo_analyze` | Cross-document synthesis on a question | 3 | OAuth |
| `avocabo_insights` | Get trending topics, contradictions, entity updates | 2 | OAuth |
| `avocabo_preferences` | Read user's focus areas and watchlists | 1 | OAuth |
| `avocabo_recent` | Get recently ingested items | 1 | OAuth |

### Usage Scenarios

**Claude Desktop:** "Based on my Avocabo library, what's the latest on AI regulation?"
→ Claude calls `avocabo_search` + `avocabo_analyze` → synthesized answer with citations.

**Cursor IDE:** "What did my newsletters say about Bun vs. Node.js performance?"
→ Cursor calls `avocabo_search` → returns relevant passages with links.

**Custom agents:** A user's personal research agent calls `avocabo_insights` daily to prepare a briefing email.

### Architecture

```
MCP Client (Claude, Cursor, etc.)
  ↓ MCP protocol (Streamable HTTP)
Avocabo MCP Server (TanStack Start route)
  ↓ Auth: OAuth 2.1 via @arki/auth
  ↓ Rate limit: @arki/kv (per-user, per-tool)
Avocabo Backend
  ├── SemanticSearchService (search, analyze)
  ├── SummarizationService (summarize)
  ├── ClusterService (insights)
  └── ContentService (recent, preferences)
```

The MCP server is a TanStack Start API route that translates MCP tool calls into backend service calls. No separate service needed — it's a thin protocol adapter layer.

### Auth Flow

1. MCP client initiates OAuth 2.1 authorization
2. User authorizes Avocabo access in browser (scopes: `read:content`, `read:insights`)
3. MCP client receives access token
4. All subsequent MCP calls include bearer token
5. `@arki/auth` validates token, resolves user, enforces rate limits

---

## 3. Avocabo as MCP Client

Avocabo can also **consume** MCP servers to expand its capabilities:

### High-Value MCP Servers to Integrate

| MCP Server | Purpose | Integration Point |
|-----------|---------|-------------------|
| **Web Search** (Brave, Exa, Tavily) | Enrich research queries with web results | Agentic RAG follow-up step |
| **Notion** | Import/sync user's knowledge base | `pkm-export` feature bidirectional |
| **Linear/GitHub** | Link content to tasks and issues | Watchlist actions ("create task from insight") |
| **Calendar** | Time-aware briefings ("before your 2pm meeting") | Daily digest context |
| **Slack** | Share insights to channels | Team workspace integration |
| **RSS feeds** | Additional content sources | `newsletter-ingestion` expansion |

### Implementation

MCP client connections managed by a `MCPClientManager` in the backend:

1. User configures MCP server connections in settings (URL, auth)
2. `MCPClientManager` maintains connection pool per user
3. Backend services call MCP tools as needed (e.g., agentic search calls web search MCP)
4. **Credential storage:** OAuth tokens and connection secrets stored via `@arki/auth` (encrypted DB column), **not** in `@arki/kv`. Only non-sensitive connection metadata (server URL, capability cache, connection health) lives in `@arki/kv`.
5. Tool discovery cached — server capabilities refreshed every 24 hours

---

## 4. Security Considerations

### MCP Server Risks (external clients accessing Avocabo)

| Risk | Mitigation |
|------|-----------|
| Token theft | Short-lived access tokens (1 hour), refresh tokens with rotation |
| Over-permissioned access | Granular OAuth scopes — server exposes only `read:content`, `read:insights` (no `write:*` scopes). External clients cannot modify user data. |
| Rate abuse | Per-user, per-tool rate limits in `@arki/kv` (100 calls/hour default) |
| Data exfiltration | Audit log of all MCP server access (stored via `@arki/queue` audit job) |
| MCP client vulnerabilities | Validate all tool inputs with Zod schemas before processing |
| Prompt injection via MCP | Sanitize MCP tool outputs before including in LLM prompts |

### MCP Client Risks (Avocabo calling external services)

| Risk | Mitigation |
|------|-----------|
| Leaked external credentials | OAuth tokens for external services (Linear, Notion, etc.) stored via `@arki/auth` with encryption-at-rest, never in `@arki/kv` or logs |
| Over-broad write permissions | Each external integration requests minimum required scopes. Write actions (e.g., "create Linear task from insight") require explicit per-action user consent, not blanket write scope. |
| External service compromise | Scoped tokens per service; revoking one integration doesn't affect others. Token refresh rotation enforced. |
| Unexpected external mutations | All write-side MCP client calls (Linear task creation, Notion sync-back) are audit-logged and rate-limited separately from read calls |

---

## 5. 30/60/90 MCP Delivery Plan

### Day 30: Foundation

- Implement MCP server skeleton in TanStack Start
- `avocabo_search` and `avocabo_recent` tools (simplest, read-only)
- OAuth 2.1 integration with `@arki/auth`
- Basic rate limiting via `@arki/kv`

### Day 60: Core Intelligence

- `avocabo_summarize` and `avocabo_insights` tools
- `avocabo_analyze` (cross-document synthesis via Lane 3)
- Web search MCP client integration for agentic RAG enrichment
- Per-tool usage analytics via `@arki/queue`

### Day 90: Ecosystem

- `avocabo_preferences` tool (watchlist and focus area access)
- Notion and Linear MCP client integrations
- MCP server discovery page in settings UI
- Audit dashboard for MCP access patterns

---

## 6. Cost Implications

MCP server calls are essentially API calls to existing Avocabo services. The cost is primarily the underlying AI processing:

| MCP Tool | Underlying Cost | Notes |
|----------|----------------|-------|
| `avocabo_search` | ~$0.003 (embedding + rerank) | Same as in-app search |
| `avocabo_summarize` | ~$0.005 (Lane 2 LLM) | Pre-cached if recently generated |
| `avocabo_analyze` | ~$0.05-0.10 (Lane 3, agentic) | Most expensive, daily-limited |
| `avocabo_insights` | ~$0.001 (cached in @arki/kv) | Pre-computed by background jobs |
| `avocabo_recent` | ~$0 (database query only) | No AI cost |

**Total MCP overhead:** Minimal — leverages existing infrastructure. The main risk is increased query volume from power users with multiple MCP clients, mitigated by per-user rate limits.

---

## Sources

- MCP specification: <https://modelcontextprotocol.io/specification/2025-06-18>
- MCP server registry: <https://github.com/modelcontextprotocol/servers>
- MCP auth (OAuth): <https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization>
- Anthropic MCP connector: <https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector>
