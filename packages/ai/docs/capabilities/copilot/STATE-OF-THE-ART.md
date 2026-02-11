# State of the Art: Conversational AI & RAG-Based Copilots (2024-2026)

## Overview

AI copilots for knowledge work have evolved from simple chatbots to retrieval-augmented conversational agents with multi-turn reasoning, tool use, and grounded citations. This document surveys the techniques, architectures, and best practices relevant to Avocabo's personal knowledge copilot.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 2011 | Siri / Google Assistant | Voice-activated information retrieval |
| 2017 | Transformer architecture | Attention mechanisms for contextual understanding |
| 2018 | BERT for QA | Extractive question answering from passages |
| 2020 | RAG (Lewis et al.) | Retrieval-augmented generation for grounded answers |
| 2022 | ChatGPT | Conversational AI reaches mainstream |
| 2023 | Copilot paradigm | AI assistants embedded in workflows (GitHub Copilot, M365) |
| 2023 | Tool-augmented agents | LLMs calling external tools and APIs |
| 2024 | Multi-turn RAG | Conversational search with context carryover |
| 2025 | Agentic copilots | Plan → search → reason → act cycles |
| 2026 | Personal knowledge agents | Copilots grounded in personal content libraries |

### Paradigm Shifts

```
FAQ Bots (pattern matching, 2000s)
    ↓
Extractive QA (BERT, 2018-2022)
    ↓
Generative QA (LLM + RAG, 2022-2024)
    ↓
Conversational RAG (multi-turn, cited, 2024-2025)
    ↓
Agentic Knowledge Copilot (plan + search + reason + act, 2025+)
```

## Current State

### Copilot Architecture Comparison

| Architecture | Quality | Latency | Cost | Grounding | Multi-Turn |
|-------------|---------|---------|------|-----------|------------|
| Direct LLM (no RAG) | Moderate | Fast | Low | None (hallucination risk) | Yes |
| Single-turn RAG | Good | ~2s | Moderate | Good | No |
| Multi-turn RAG | Very Good | ~3s | Higher | Good | Yes |
| Agentic RAG | Excellent | 5-15s | Highest | Excellent | Yes |
| Hybrid (simple → agentic) | Excellent | Variable | Optimized | Excellent | Yes |

### RAG Pipeline Components

```
User question + conversation history
  → Query reformulation (rewrite in context of prior turns)
  → Intent classification (simple lookup vs. deep research)
  → Retrieval (hybrid search + reranking)
  → Context assembly (retrieved passages + conversation history)
  → Generation (LLM with system prompt + context + question)
  → Citation attachment (link claims to source passages)
  → Response streaming to user
```

### Commercial Copilot Landscape (Feb 2026)

| Product | Domain | RAG Approach | Differentiator |
|---------|--------|-------------|----------------|
| Readwise Ghostreader | Reading highlights | Simple RAG over highlights | Integrated in reader UX |
| Notion AI | Workspace notes | RAG over workspace content | Deep Notion integration |
| Perplexity | Web search | Agentic search + synthesis | Real-time web grounding |
| GitHub Copilot | Code | Code-specific RAG + autocomplete | IDE integration |
| Microsoft 365 Copilot | Office docs | Enterprise RAG (Graph API) | Microsoft ecosystem |

**Avocabo's differentiation:** Grounded in curated newsletter/podcast/video content (not the whole web), with cross-document intelligence (contradictions, trends, entities).

## Architecture Patterns

### Conversational Query Reformulation

Multi-turn conversation requires rewriting each query to be self-contained:

```
Turn 1: "What's happening with AI regulation?"
  → Search: "AI regulation recent developments"
  → Answer: "The EU AI Act is being enforced, and..."

Turn 2: "How does that compare to the US approach?"
  → Naive search: "How does that compare to the US approach?" (ambiguous)
  → Reformulated: "How does US AI regulation compare to EU AI Act enforcement?"
  → Much better retrieval results
```

**Implementation:** Fast LLM call (Lane 1) to rewrite query with conversation context before retrieval.

### Intent-Based Routing

Not all copilot queries need the same pipeline:

| Intent | Example | Pipeline | Cost |
|--------|---------|----------|------|
| Quick lookup | "When was that OpenAI article published?" | Simple search | $0.003 |
| Summarization | "Summarize what I've read about AI safety" | Multi-doc synthesis | $0.01 |
| Analysis | "What are the main arguments for and against open-source LLMs?" | Agentic RAG | $0.05 |
| Action | "Create a watchlist for AI regulation updates" | Tool use | $0.002 |
| Clarification | "What did you mean by 'competitive moat'?" | Context only (no retrieval) | $0.001 |

### Citation and Evidence Pipeline

```
Generated answer: "Revenue grew 25% in Q4 [1], primarily driven by cloud services [1,2]."

Citation verification:
  [1] → Link to newsletter passage: "...reported 25% year-over-year revenue growth..."
  [2] → Link to podcast transcript: "...cloud division was the primary growth engine..."

User clicks [1] → Shows source passage with highlight
User clicks "show evidence" → Expands all cited passages inline
```

## Key Technologies

### Conversation Memory Management

| Strategy | Context Window | Cost | Quality |
|----------|---------------|------|---------|
| Full history (stuff all) | Linear growth | Expensive for long convos | Best |
| Sliding window (last N turns) | Fixed | Predictable | Loses early context |
| Summarized history | Compressed | Moderate | Good (with quality summarizer) |
| Hybrid (recent + summarized old) | Bounded | Moderate | Very Good |

**Recommendation for Avocabo:** Hybrid approach. Keep last 5 turns verbatim, summarize older turns into a "conversation context" block. Max context allocation for conversation: 10K tokens.

### Tool Use Patterns

| Tool | When Used | Integration |
|------|-----------|-------------|
| `search` | Answer questions about user's content | SemanticSearchService |
| `getEntity` | Look up entity details and relationships | EntityService |
| `getTrends` | Analyze topic trends over time | TrendAnalysisService |
| `createWatchlist` | User wants to track a topic | WatchlistService |
| `getDigest` | "What's in today's digest?" | DigestService |
| `explainChart` | Visual content analysis | VLM Pipeline |

### Streaming Response Pattern

```
User asks question
  → Start streaming immediately
  → [Retrieving sources...]  (shown while retrieval runs)
  → Stream answer tokens as they're generated
  → Append citations at end
  → Total perceived latency: ~500ms to first token
```

## Advanced Techniques (2025-2026)

### Agentic Copilot (Plan → Search → Reason → Respond)

For complex questions, the copilot acts as an agent:

```
User: "Based on my reading, should I invest in AI infrastructure companies?"

Agent thinking:
  1. Decompose: What AI infra companies has user read about?
  2. Search: user's library for AI infrastructure content
  3. Analyze: What are the arguments for/against?
  4. Cross-reference: Any contradictions between sources?
  5. Synthesize: Balanced analysis with citations

Output: Multi-paragraph analysis with:
  - Key companies mentioned in user's sources
  - Bull and bear arguments from different newsletters
  - Contradictions flagged
  - "Note: This is based on your content library, not financial advice"
```

### Personal Knowledge Graph Integration

The copilot can query the cross-document-intelligence entity graph:

```
User: "What do I know about Sam Altman?"

→ Entity lookup: "Sam Altman" → entity profile
→ Relationships: CEO of OpenAI, invested in X, mentioned alongside Y
→ Content: 15 items mention Sam Altman across 8 clusters
→ Trends: Mentions increased 3x in last month
→ Synthesis: "Based on 15 articles in your library, Sam Altman is..."
```

### Proactive Insights

The copilot surfaces insights without being asked:

```
"I noticed 3 newsletters this week mentioned rising GPU prices.
This is relevant to your 'AI Infrastructure' watchlist.
Would you like a synthesis of what your sources are saying?"
```

**Implementation:** Background job (`@arki/queue`) runs daily analysis on new content against user's interests. Surfaces as copilot suggestions in UI.

### "What Would I Know?" Feature

Synthesizes the user's accumulated knowledge on a topic:

```
User: "What would I know about quantum computing based on everything I've read?"

→ Retrieve all content tagged/clustered as quantum computing
→ Synthesize a "knowledge state" document
→ Include: what the user has covered, gaps, recency of information
→ "Based on 12 articles over 3 months, you'd know that... However, you haven't
   read about [recent development] which changes the picture."
```

## Evaluation Metrics

### Answer Quality

| Metric | Description | How Measured |
|--------|-------------|-------------|
| Correctness | Does the answer match ground truth? | LLM-as-judge or human eval |
| Faithfulness | Are all claims supported by retrieved context? | Citation verification pipeline |
| Relevance | Does the answer address the question? | LLM-as-judge |
| Helpfulness | Would the user find this useful? | User feedback (thumbs up/down) |
| Completeness | Does it cover the important aspects? | LLM-as-judge with checklist |

### Conversation Quality

| Metric | Description |
|--------|-------------|
| Turn resolution rate | % questions answered satisfactorily in ≤2 turns |
| Context coherence | Does the copilot maintain context across turns? |
| Citation accuracy | % citations that correctly point to relevant source passages |
| Hallucination rate | % claims not supported by any retrieved content |
| Tool use accuracy | % tool calls that returned useful results |

## Challenges and Limitations

1. **Retrieval quality bottleneck:** The copilot is only as good as its retrieval. Poor search results → poor answers.
2. **Multi-turn context management:** Long conversations exceed context windows. Summarization loses nuance.
3. **Hallucination persistence:** Even with RAG, LLMs sometimes generate claims not in the retrieved context.
4. **Latency expectations:** Users expect chat-like speed (<2s), but agentic queries take 5-15s.
5. **Over-reliance risk:** Users may trust copilot answers without checking sources. Citation UX must be prominent.
6. **Privacy in shared workspaces:** Team copilot must respect per-user content access permissions.

## Best Practices for Avocabo

1. **Intent routing first** — classify query before choosing pipeline. Save agentic for complex queries.
2. **Always cite** — every factual claim must link to a source passage. No unsupported assertions.
3. **Stream responses** — show first tokens within 500ms. Users tolerate longer total time if they see progress.
4. **Reformulate multi-turn queries** — silent query rewriting dramatically improves retrieval in conversation.
5. **Budget agentic queries** — max 5 retrieval steps, $0.10 cost ceiling per query.
6. **Surface confidence** — low-confidence answers should be flagged. "Based on limited sources, I think..."

## References

1. Lewis, P., et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"
2. Gao, L., et al. (2023). "Retrieval-Augmented Generation for Large Language Models: A Survey"
3. Shuster, K., et al. (2021). "Retrieval Augmentation Reduces Hallucination in Conversation"
4. Schick, T., et al. (2023). "Toolformer: Language Models Can Teach Themselves to Use Tools"
5. Yao, S., et al. (2022). "ReAct: Synergizing Reasoning and Acting in Language Models"
6. Zheng, L., et al. (2023). "Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena"
7. Asai, A., et al. (2024). "Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection"
