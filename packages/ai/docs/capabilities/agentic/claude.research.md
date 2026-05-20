# 14 AI Agent Frameworks Ranked for a Solo TypeScript Bootstrapper: Pick Mastra

## TL;DR

- **Pick Mastra.** It is the only framework on the list that is TypeScript-native, Apache-2.0 self-hostable on Hetzner/Coolify, ships a durable workflow engine with suspend/resume + HITL, and has visible production users (Replit Agent 3, Marsh McLennan, SoftBank, Medusa). It fits your existing Node.js + PostgreSQL stack with zero Python sidecar.
- **Two strong alternatives:** **Vercel AI SDK + Inngest/Temporal** (lightest possible customer-facing layer if you're skeptical of bigger frameworks) and **LangGraph (Python or JS)** (pick this only if multi-agent orchestration depth matters more than DX and you accept Python complexity).
- **Four of the 14 are not really "frameworks you pick":** **A2A** and **Open Agent Spec** are interoperability protocols/standards, not runtimes; **Deep Agents** is a harness _on top of_ LangGraph (a niche choice, not a general framework); **"Built-in Agent"** is best read as the _OpenAI Agents SDK_ / _Vercel AI SDK ToolLoopAgent_ (SDK-native primitives, not full frameworks). Treat these separately.

---

## Key Findings

1. **There is no neutral "best" framework — there's a best framework for your stack.** Romanian solo dev shipping multiple products under ImpressiveWorks, on TypeScript/Node.js + PostgreSQL + Hetzner/Coolify, primarily building consumer apps like EverSeek: this profile maps onto **Mastra** more cleanly than any other option in the list.
2. **The TypeScript agent ecosystem matured significantly in early 2026.** Mastra 1.0 shipped January 20, 2026 with ~19.8k GitHub stars and 300+ contributors at launch (per the official Mastra 1.0 announcement: "Mastra sees over 300k weekly npm downloads, has ~19.8k GitHub stars, 300+ contributors, and a community of roughly 4,800 developers on Discord"), growing to 22,276+ stars by March 24, 2026 (Generative.inc's complete guide notes "growing at approximately 30–35 per day"). 300k+ weekly npm downloads at launch, 1.8M/month by Feb 2026. Mastra's workflow engine has `.suspend()`/`.resume()`, snapshot storage, time-travel debugging, and optional Inngest-backed durable execution.
3. **The Python "big three" are LangGraph, CrewAI, and Pydantic AI.** LangGraph is the most mature but verbose; CrewAI Flows is fast to prototype but more opinionated; Pydantic AI scored highest on DX in third-party tests (8/10 vs LangChain's 5/10 in the Nextbuild 90-day benchmark cited by Speakeasy).
4. **Vendor-tied frameworks (Microsoft Agent Framework, Google ADK, AWS Strands, OpenAI Agents SDK) all have escape hatches but their docs, examples, and runtimes push you toward their cloud.** For a solo bootstrap dev who values self-hosting on Hetzner, that's a quiet lock-in cost.
5. **"Deep Agents" is not a peer to LangGraph or Mastra.** It is a _harness_ built on LangGraph that adds planning, subagents, a virtual filesystem, and Claude-Code-style context engineering. You'd use it inside a LangGraph deployment for research/coding-style long-horizon agents — not as your primary framework.
6. **A2A and Open Agent Spec are protocols.** Per the Linux Foundation's April 9, 2026 press release, A2A's "supporting organizations [have] grown from more than 50 to over 150 — including AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, and ServiceNow." Open Agent Spec (Oracle, late 2025, arXiv 2510.04173) is a declarative YAML/JSON schema for portable agent definitions. Both are complements to your framework choice, not replacements for it.

---

## Details: Profile of Each Option

### 1. "Built-in Agent" → OpenAI Agents SDK / Vercel AI SDK ToolLoopAgent

**What it is.** The most likely referent here is one of two "SDK-native" agent primitives that ship as opinionated thin wrappers, rather than full frameworks:

- **OpenAI Agents SDK** (Python and TypeScript). Released early 2025 as the production-grade successor to Swarm. Primitives: Agents, Handoffs, Guardrails, Sessions, Tracing, Sandbox Agents. ~19k+ GitHub stars (Python) plus ~2.4k (JS) as of late 2025. MIT license. Provider-agnostic through Chat Completions but best with OpenAI models.
- **Vercel AI SDK** (TypeScript-only). With AI SDK 5 (Jul 2025) and AI SDK 6, it ships `generateText`/`streamText` with `stopWhen`/`prepareStep` loop control, and a class-based `ToolLoopAgent`. Vercel's own State of AI page reports "over 20 million monthly downloads" and that the AI SDK is "used by 74% of surveyed developers," with adoption ranging from startups to Fortune 500 companies; used by Thomson Reuters' CoCounsel (3 devs, 2 months). Apache 2.0.

**For your use case.** Vercel AI SDK is excellent for the _customer-facing_ part of EverSeek (streaming Bible explanations with structured output) — but it is intentionally not a multi-agent orchestrator. OpenAI Agents SDK is more agent-shaped but biases you toward OpenAI's stack. **Neither is a complete answer to "production agents AND multi-agent orchestration"; both work well _underneath_ a framework.** In fact, Mastra uses the Vercel AI SDK underneath for model calls.

**Verdict.** Use Vercel AI SDK as the LLM/UI layer, not as your orchestration framework.

---

### 2. LangChain (LangGraph)

**What it is.** LangGraph is the LangChain team's low-level graph-based agent runtime. Python + TypeScript with full feature parity. MIT license. Used in production by Klarna, Uber, LinkedIn, JPMorgan, BlackRock, Replit, Cisco, Elastic. Per Firecrawl's 2026 open-source agent frameworks guide, "over 24,800 GitHub stars and 34.5 million monthly downloads"; pypistats.org now shows the `langgraph` package at ~46.5 million monthly downloads (May 2026), so the 34.5M figure is already conservative.

**Architecture.** State machine: nodes are functions, edges are conditional transitions, shared state object flows through. Pregel-inspired. Checkpointing/persistence is first-class; durable execution, streaming, HITL, time-travel are built in.

**DX.** Verbose. Simple agents that take 20 lines in CrewAI or Mastra take 50+ lines in LangGraph. LangSmith handles tracing and observability (paid SaaS, but otel-compatible). TypeScript SDK trails Python by ~4–8 weeks per release.

**For your use case.** Most powerful multi-agent orchestration available, but the boilerplate tax for a solo dev shipping multiple products is real. If you want fine-grained control over a single complex pipeline (e.g., a 6-step research → write → review → publish flow) and accept the cost, this is the gold standard.

**Lock-in.** Very low at the framework level (MIT, self-hostable). Soft lock-in to LangSmith for tracing if you adopt it.

---

### 3. Deep Agents

**What it is.** A LangChain-authored _harness_ (Python + TypeScript, MIT) built on top of LangGraph. Adds: a planning tool (`write_todos`), a virtual filesystem (`read_file`/`write_file`/`edit_file`/`grep`), subagent delegation with isolated context, a Claude-Code-inspired system prompt, summarization/compression middleware, and provider-agnostic model selection. Designed for long-horizon tasks like research and coding agents.

**Architecture.** Not a peer framework. It is "LangGraph with batteries included" for the specific deep-research/coding pattern.

**For your use case.** Useful for your **research and content pipeline** specifically — generate a research report, summarize a Bible commentary, etc. But you don't pick "Deep Agents" as your single framework; you'd run it on LangGraph. **Skip as a primary choice; revisit if/when you need a Claude-Code-style autonomous research agent.**

---

### 4. ADK (Google Agent Development Kit)

**What it is.** Apache-2.0 open-source agent framework released by Google in April 2025. Python first; TypeScript, Go, and Java SDKs followed in late 2025 / early 2026. ADK 2.0 (2026) introduced graph-based workflows, a visual builder, and deeper A2A protocol support. Powers Google Agentspace, Customer Engagement Suite.

**DX.** Strong: ADK Dev UI for visualization/debugging, evaluation framework with evalsets and LLM-as-judge, one-command deploys to Vertex AI Agent Engine / Cloud Run / GKE.

**Lock-in.** Model-agnostic in theory (LiteLLM bridge → OpenAI/Anthropic/Mistral/Bedrock/etc.), but defaults, examples, and managed runtime all point at Gemini + GCP. The integrations launch in February 2026 (GitHub, Jira, MongoDB, Pinecone, etc.) made it stronger as an execution layer, but it remains Google-flavored.

**For your use case.** You're on Hetzner, not GCP. The pull toward Vertex AI Agent Engine is the kind of soft lock-in you explicitly want to avoid. **Skip.**

---

### 5. Microsoft Agent Framework

**What it is.** The merger of Semantic Kernel + AutoGen, announced October 2025 (public preview), with 1.0 GA in early-mid 2026. Python and .NET (Java/JS coming). MIT-licensed. Brings AutoGen's multi-agent abstractions, Semantic Kernel's enterprise plumbing (typed kernel, middleware, telemetry), and adds a graph-based workflow engine with sequential/concurrent/handoff/group-chat patterns. Native MCP and A2A 1.0 support. OpenTelemetry built-in.

**Lock-in.** Open-source, but docs/examples and the managed Azure AI Foundry Agent Service make Azure the path of least resistance.

**For your use case.** You're not on Azure and you're not a .NET shop. Plus it's still settling its API (RC → GA in 2026 with breaking changes from AutoGen). **Skip.**

---

### 6. AWS Strands Agents

**What it is.** Apache-2.0 model-driven agent SDK from AWS, released May 2025. Python first; **TypeScript support is in preview as of December 2025**. Lean — agents are `Agent(tools=[...], prompt="...")` in 3 lines. Production use inside AWS for Q Developer, AWS Glue, VPC Reachability Analyzer; external production users include Smartsheet, Swisscom, Landchecker, Elva, Jit. Multi-agent constructs: Swarm, Graph, Workflow, Agent-as-Tool.

**Lock-in.** Model-agnostic (Bedrock, Anthropic, OpenAI, Ollama, Llama via LiteLLM), but heavily oriented toward Amazon Bedrock AgentCore as the production runtime. Strong AWS gravity.

**For your use case.** Same problem as ADK and MAF — you're on Hetzner, not AWS. **Skip.**

---

### 7. Mastra ⭐ Recommended

**What it is.** Apache-2.0 TypeScript-native AI framework from the team behind Gatsby. Funded with a $13M seed from 120+ investors including Y Combinator, Paul Graham, and Guillermo Rauch, then a $22M Series A led by Spark Capital on April 9, 2026, bringing total capital to $35M (per Mastra's official Series A announcement: "We're excited to announce that Mastra has raised a $22M Series A led by Spark Capital, bringing our total capital raised to $35M"). Mastra 1.0 shipped **January 20, 2026**. Stars grew from ~19.8k at launch to 22,276+ by late March 2026 ("growing at approximately 30–35 per day"), with **300k+ weekly npm downloads** at launch (1.8M/month by Feb 2026). Built on top of the Vercel AI SDK for model routing.

**Core pieces.**

- **Agents**: `new Agent({ model: "openai/gpt-4-turbo", tools, instructions })`. String-based provider/model identifiers support ~100 direct providers and gateway aggregators (OpenRouter, Vercel, Netlify, Azure), giving access to 1,000+ models. Automatic fallback across providers.
- **Workflows**: Step-based with branching, parallel, loops, retries, **`.suspend()`/`.resume()` for HITL**, snapshots stored to libSQL (default) or Postgres/MongoDB/DynamoDB/Cloudflare D1/MSSQL/Aurora DSQL; optional Inngest backend for fully durable execution with step memoization and retries. Time-travel debugging via `Run.timeTravel()`.
- **Memory**: short + long-term, libSQL/Postgres backends, "Observational Memory" for 4–10x token savings.
- **Studio**: a local visual IDE for inspecting tool calls, replaying runs, viewing token usage (open-source, runs via `mastra studio`).
- **Observability**: OpenTelemetry-native, integrates with Langfuse and Mastra's own platform.
- **MCP**: first-class support.

**Production users with quantitative outcomes.**

- **Replit Agent 3**: "boosted success rates from 80% to 96%" using Mastra durable execution with Inngest; spins up thousands of isolated Docker sandboxes daily.
- **Marsh McLennan**: 75,000 employees use a Mastra-built agentic search tool.
- **SoftBank Satto Workspace**: 1.5 months from requirements to production; tasks that took hours now take 1–2 minutes.
- **MedusaJS**: built their "AI solutions engineer" on Mastra; rolled out to six initial customer companies.
- **11x "Alice" AI SDR**: 50,000 AI-driven emails/day.
- Also: PayPal, Sanity, Brex, Workday, Adobe, Elastic, Docker, WorkOS in production.

**Pricing/licensing.** Apache 2.0 self-hosted is free forever. A few features live in `ee/` directories (e.g., RBAC for Studio in production) under a source-available enterprise license. Mastra Platform (hosted): Starter free, **Teams $250/mo** with SOC 2 docs, Enterprise custom. Memory Gateway adds a 5.5% markup on token usage.

**Caveats.** Pre-1.0 it shipped breaking changes between minor versions; 1.0 stabilizes the API. **No SOC 2 certification yet (as of March 2026)** — if you ever need to sell to enterprises with hard SOC 2 requirements, plan for that. Community is still smaller than LangChain — Stack Overflow answers and tutorials are an order of magnitude thinner.

**For your use case.** This is the answer for ImpressiveWorks. TypeScript-native (no Python sidecar), runs on Hetzner/Coolify (it's just a Node app), durable workflows for content pipelines, suspend/resume for HITL editorial review in EverSeek-style products, swap LLM providers with a one-line string change.

---

### 8. Pydantic AI

**What it is.** Python-only agent framework from the Pydantic team. **v1.0 shipped September 2025** with an explicit 6-month minimum API stability commitment. 16.5k+ GitHub stars by Q2 2026, 15M+ downloads. Backed by Pydantic Logfire for OpenTelemetry-native observability.

**Strengths.** Type safety throughout, dependency injection that feels like FastAPI, structured output via Pydantic schemas with automatic self-correction, model-agnostic (OpenAI/Anthropic/Gemini/Bedrock/Vertex/Ollama/LiteLLM and many more). HITL tool approval. Scored highest on DX (8/10) in the Nextbuild 90-day benchmark (LangChain scored 5/10). The type system caught 23 bugs that would have reached production in LangChain.

**Multi-agent.** Supports agent delegation (one agent calls another as a tool) and programmatic hand-off; lacks LangGraph-style explicit graph orchestration but you can compose freely.

**For your use case.** If you preferred Python, this would be a top pick. You're TypeScript-first. **Skip as primary, keep on watchlist** if you ever need a Python service alongside Node.

---

### 9. CrewAI Flows

**What it is.** Python framework. CrewAI's core "Crews" (role-based collaborative agents — Researcher / Writer / Editor) plus the more recent **Flows** layer for deterministic, event-driven orchestration with conditional logic, state management, and the ability to invoke Crews from Flows. Apache-2.0. 44,600+ GitHub stars. CrewAI markets "12M+ executions/day" through Flows.

**Strengths.** Fastest path from idea to working multi-agent prototype: define agents with role/goal/backstory, point them at tasks, ship. YAML-based config available. CrewAI Enterprise offers a managed control plane, UI, observability, RBAC.

**Cons.** The Crew abstraction can feel constraining outside neat "team of specialists" patterns; multiple production reviews flag a tendency to outgrow CrewAI and migrate to LangGraph for fine-grained control.

**For your use case.** Excellent if you wanted a Python-first content pipeline. As a TypeScript shop, you'd carry the same Python sidecar tax. **Skip.**

---

### 10. Agno (formerly Phidata)

**What it is.** Python-only high-performance agent runtime. Rebranded from Phidata in January 2025. ~39k GitHub stars. Claims ~2µs agent instantiation and 3.75 KiB memory per agent ("5000x faster than LangGraph"). Apache-2.0. Provides "AgentOS" abstractions for Teams, Workflows, multimodal (text/image/audio/video), 80 toolkits with thousands of tools.

**For your use case.** Excellent performance characteristics but Python-only. Same Python sidecar tax. **Skip.**

---

### 11. AG2 (community AutoGen fork)

**What it is.** Apache-2.0 community fork maintained by the AutoGen original creators (Chi Wang, Qingyun Wu) after they left Microsoft in late 2024. Continues the AutoGen 0.2 conversation-centric architecture under ag2ai/ag2 on GitHub, owns the `pyautogen`/`autogen` PyPI packages. ~20k builders. Currently iterating toward v1.0 via the `autogen.beta` namespace which adds streaming, event-driven architecture, multi-provider LLM support, dependency injection, typed tools, first-class testing.

**For your use case.** Python-only, conversation-centric (token-expensive), and Microsoft's own roadmap now points at Agent Framework rather than AutoGen. **Skip.**

---

### 12. Open Agent Spec (Oracle) — _Standard, not framework_

**What it is.** A declarative schema (JSON/YAML, with PyAgentSpec Python SDK) introduced by Oracle in late 2025 (arXiv 2510.04173). Aims to be the ONNX of agents: define an agent once, run via any compatible runtime adapter (WayFlow reference runtime, plus planned LangGraph/AutoGen adapters). Complements MCP and A2A.

**For your use case.** Adoption is still early and Oracle-led. **Do not treat this as a framework choice — track it as you'd track ONNX in 2017.**

---

### 13. LlamaIndex (Workflows + AgentWorkflow)

**What it is.** Python and TypeScript. MIT license. Long the go-to for RAG; rebranded in 2024–25 toward agent + workflow orchestration. **Workflows 1.0 shipped June 30, 2025** as a standalone package (`llama-index-workflows` / `@llamaindex/workflow-core`). Event-driven, async-first, durable, stateful. AgentWorkflow ships pre-built multi-agent patterns including handoff between role-specialized agents.

**Strengths.** Best RAG primitives in the business: ingestion, parsing (LlamaParse for PDFs/PPTs), indexing strategies, retrieval. If EverSeek leans heavily on Bible verse retrieval and citation, LlamaIndex's RAG layer is genuinely best-in-class.

**For your use case.** Strong second option if your agents are RAG-dominant. But for general multi-agent orchestration and customer-facing chat, Mastra has a cleaner DX in TypeScript. **Consider pairing**: use LlamaIndexTS (or even the Python LlamaIndex behind a tool boundary) for retrieval/parsing, but keep Mastra as your orchestrator.

---

### 14. A2A (Agent-to-Agent protocol) — _Protocol, not framework_

**What it is.** Open specification announced by Google April 9, 2025, donated to the Linux Foundation in June 2025, now hosted at a2a-protocol.org. Per the Linux Foundation's April 9, 2026 press release, "Since April 2025, the number of supporting organizations has grown from more than 50 to over 150 — including AWS, Cisco, Google, IBM, Microsoft, Salesforce, SAP, and ServiceNow." Defines how agents (a) advertise capabilities via Agent Cards, (b) exchange Tasks/Messages/Artifacts, and (c) transport via JSON-RPC over HTTP/SSE/gRPC with OAuth/mTLS auth. Complements MCP (which connects agents to tools); A2A connects agents to agents. Native support is shipping in Google ADK, LangGraph, CrewAI, LlamaIndex, Semantic Kernel/MAF.

**For your use case.** Not something you "pick" instead of Mastra. Relevant later if you ever expose agents to third parties or integrate with vendor agents (Salesforce, SAP, ServiceNow). **Track it; don't build on it day one.**

---

## Comparative Ranking Table

Scored 1–5 per criterion (5 = best for _this user's_ use case). Bold = top pick.

| #   | Framework                       | DX               | Multi-Agent / Orchestration | Self-host / Low Lock-in | Performance & Cost | Ecosystem & Community | **Total** |
| --- | ------------------------------- | ---------------- | --------------------------- | ----------------------- | ------------------ | --------------------- | --------- |
| 1   | **Mastra** ⭐                   | **5**            | 4                           | **5**                   | 4                  | 3                     | **21**    |
| 2   | Vercel AI SDK (Built-in Agent)  | 5                | 2                           | 5                       | 5                  | 5                     | 22\*      |
| 3   | LangGraph (TS)                  | 3                | **5**                       | 4                       | 3                  | **5**                 | 20        |
| 4   | LangGraph (Python)              | 3                | **5**                       | 4                       | 3                  | **5**                 | 20        |
| 5   | Pydantic AI                     | 4                | 3                           | 5                       | 4                  | 3                     | 19        |
| 6   | LlamaIndex (TS/Python)          | 4                | 4                           | 4                       | 3                  | 4                     | 19        |
| 7   | OpenAI Agents SDK               | 4                | 3                           | 3                       | 4                  | 4                     | 18        |
| 8   | CrewAI Flows                    | 4                | 4                           | 4                       | 3                  | 4                     | 19        |
| 9   | Microsoft Agent Framework       | 3                | 4                           | 3                       | 3                  | 3                     | 16        |
| 10  | Google ADK                      | 4                | 4                           | 3                       | 3                  | 3                     | 17        |
| 11  | AWS Strands                     | 4                | 3                           | 2                       | 4                  | 2                     | 15        |
| 12  | Agno                            | 4                | 3                           | 4                       | **5**              | 3                     | 19        |
| 13  | AG2                             | 2                | 4                           | 4                       | 2                  | 2                     | 14        |
| 14  | Deep Agents (LangGraph harness) | 3                | 4                           | 4                       | 3                  | 2                     | 16        |
| —   | A2A (protocol)                  | n/a — complement |                             |                         |                    |                       | —         |
| —   | Open Agent Spec (standard)      | n/a — complement |                             |                         |                    |                       | —         |

\*Vercel AI SDK scores high overall but loses on Criterion 2 (multi-agent orchestration), which is the user's hard requirement. That's why Mastra wins on aggregate fit.

### Overall ranking from best to worst fit for _this_ user

1. **Mastra** — TypeScript-native, self-hostable, durable workflows, HITL, growing fast, real production proof.
2. **Vercel AI SDK + Inngest** — strongest customer-facing UI layer, weakest at native multi-agent (needs Inngest/Temporal for durability).
3. **LangGraph (TS)** — most mature multi-agent runtime in TypeScript, but verbose and slower DX.
4. **OpenAI Agents SDK (TS)** — clean, learn-in-an-afternoon, but minimal orchestration and provider-leaning.
5. **LlamaIndex (TS)** — best if RAG dominates.
6. **LangGraph (Python)** — best Python orchestration, requires sidecar service.
7. **Pydantic AI** — best Python DX, but Python only.
8. **CrewAI Flows** — fastest Python multi-agent prototyping, Python sidecar required.
9. **Agno** — Python performance leader, narrow fit.
10. **Google ADK** — strong but GCP-pulled.
11. **Microsoft Agent Framework** — strong but Azure-pulled.
12. **AWS Strands** — strong but AWS-pulled.
13. **Deep Agents** — niche harness, not a primary choice.
14. **AG2** — stable but dwindling future.
    — **A2A** and **Open Agent Spec** are not in this ranking; they are protocols.

---

## Recommendations (Decision-Ready)

### Primary recommendation: **Adopt Mastra now for both EverSeek and your content pipelines.**

**Why specifically for you:**

- **No language switch.** ImpressiveWorks already runs on TypeScript/Node + PostgreSQL. Mastra is a Node app that talks to your existing Postgres for memory and snapshots. Deploy it via Coolify on Hetzner like any other Node service.
- **Customer-facing AND orchestration in one runtime.** Use Mastra Agents for EverSeek's "explain this verse" chat (streaming, structured output, RAG over your Bible/commentary corpus via embeddings in Postgres pgvector). Use Mastra Workflows for content pipelines: scrape source → summarize → cross-reference → human review (via `.suspend()`/`.resume()`) → publish.
- **LLM provider portability.** Swap `"openai/gpt-4-turbo"` → `"anthropic/claude-sonnet-4-5"` → `"openrouter/meta-llama/llama-3.1-70b"` to chase price/quality without rewrites. With automatic fallback, you can hedge an OpenAI outage without code.
- **Built-in observability and a local Studio.** You won't need a separate debugger or SaaS dashboard to start.
- **Self-host friendly economics.** Apache 2.0 core is free; you only pay if you opt into Mastra Platform's Studio hosting ($250/mo Teams) — and you don't have to.

**Concrete first-90-days plan.**

- **Days 1–7.** `npm create mastra` in a new package alongside EverSeek. Wire one Agent that does verse explanation, backed by Postgres pgvector. Add Langfuse for tracing.
- **Days 8–30.** Move EverSeek's AI search/explanation off whatever you have today onto the Mastra Agent. Add evals via Mastra's built-in scorers for hallucination/groundedness.
- **Days 31–60.** Build your first multi-step Workflow for content (e.g., a daily devotional generator: research → draft → editor agent → manual approval → publish).
- **Days 61–90.** Add a second product (Structurize? Ekuation?) to validate that the framework reusability claim is real. If it isn't, you'll discover that here rather than after a year of investment.

### Strong Alternative 1: **Vercel AI SDK + Inngest** — pick this if you decide Mastra is too much abstraction.

**When to pick this instead:** You want minimum surface area, you trust yourself to wire orchestration directly, and most of your "multi-agent" work is actually deterministic pipelines that Inngest's durable steps can express cleanly. The Vercel AI SDK 6 `ToolLoopAgent` is enough for the agent loop; Inngest handles durability, retries, scheduled jobs, and HITL gates.

**Trade-off:** You're building your own orchestration glue. For one product, fine. For five, you'll reinvent Mastra.

### Strong Alternative 2: **LangGraph (TypeScript or Python)** — pick this if multi-agent depth eclipses DX.

**When to pick this instead:** Your content pipeline genuinely needs graph-shaped branching with cycles, complex retries, multiple coordinated subagents, and you're prepared to write 2–3x more orchestration code in exchange for the most mature multi-agent runtime in the ecosystem. Pair with LangSmith (paid) or Langfuse (self-host) for tracing.

**Trade-off:** TypeScript SDK trails Python by 4–8 weeks per release; Python forces a sidecar service on your Hetzner box; verbose graph definitions slow you down on shipping multiple products.

### Benchmarks/thresholds that would change my recommendation

- **Switch from Mastra → LangGraph** if you discover that more than 30% of your agents need 5+ branching paths with cycles, or you need certified SOC 2 today.
- **Switch from Mastra → Vercel AI SDK + Inngest** if, after 30 days with Mastra, you find yourself fighting the Workflow abstraction or your agents are all simple single-step + tool-call.
- **Switch from Mastra → Pydantic AI** if you abandon TypeScript-first and adopt a Python-primary stack for ML reasons.
- **Add A2A** when (not if) you start integrating with third-party vendor agents (Salesforce, SAP, etc.). All major frameworks including Mastra are converging on it.
- **Add Deep Agents** behind a tool boundary if and when you build a serious long-horizon research agent (e.g., a "build a 3,000-word Bible commentary on Romans" task).

---

## Caveats

- **Mastra is pre-mature relative to LangChain.** Stack Overflow answers, blog posts, and community plugins are an order of magnitude thinner than LangGraph's. When you hit a problem at 11pm, you may need to read source. Mitigation: small, well-documented codebase + active Discord (~4,800 developers).
- **Mastra has no SOC 2 certification as of March 2026.** Irrelevant for solo consumer products like EverSeek; relevant if you later sell to enterprises that audit your dependencies.
- **Mastra 1.0 ships frequent minor releases.** API is stable post-1.0 but features and storage backends are evolving. Pin versions in package.json.
- **The "Mastra is faster than LangGraph" marketing claims** (e.g., the often-cited 1240ms vs 2450ms P95 latency, or Agno's "5000x faster" claims) come from blog posts comparing apples to oranges (TS vs Python subprocess overhead, agent instantiation alone, etc.). Treat them as directional, not definitive.
- **The "Built-in Agent" item in the original list was ambiguous.** I read it as Vercel AI SDK / OpenAI Agents SDK. If the user meant something else (e.g., a specific platform's built-in agent like Cloudflare's), the analysis would shift, but neither alternative interpretation would change the top recommendation.
- **A2A's 150+ organizations and 1.0 status** come from the Linux Foundation press release of April 9, 2026 — vendor self-reported partner counts; specific production deployment counts beyond marquee customers (Salesforce, SAP, ServiceNow) are not independently audited.
- **Replit Agent 3 quantitative claim ("80% → 96%")** is sourced from Mastra's own customer page citing Replit, not from an independent benchmark. Take it as a vendor case study, not a peer-reviewed result.
- **Model lifecycle.** Whichever framework you pick, pin specific stable model IDs (e.g., a named gpt-4 version, claude-sonnet-4-5) rather than aliases that drift.
- **You don't _have_ to choose forever.** Mastra agents and Vercel AI SDK agents are both thin enough that re-implementing on top of a different runtime in 6 months would cost days, not months. The expensive thing is your prompts, evals, and tool definitions — keep those framework-agnostic and you preserve optionality.
