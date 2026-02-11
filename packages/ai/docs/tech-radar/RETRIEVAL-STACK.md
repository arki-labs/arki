# Retrieval Stack — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. Current Architecture Recap

Avocabo's retrieval backbone is defined in the `semantic-search` and `cross-document-intelligence` feature architectures:

```
Query → SemanticSearchService
          ├── VectorSearchProvider (semantic similarity)
          ├── PostgreSQL tsvector (BM25 keyword matching)
          └── RRF merge (Reciprocal Rank Fusion)
       → Ranked results
```

This hybrid approach outperforms either vector or keyword search alone. The technology radar focuses on what comes **next** — the incremental upgrades that push search quality from "good" to "wow."

---

## 2. Reranking Layer (Phase 1 Upgrade — Day 30)

Reranking is the highest-ROI retrieval upgrade. It takes the top-N results from hybrid search and re-scores them with a purpose-built model that understands query-document relevance at a deeper level than embeddings alone.

### Provider Comparison

| Reranker | Latency (50 docs) | Cost per Query | Quality (NDCG@10) | Self-Hosted? |
|----------|-------------------|---------------|-------------------|-------------|
| **Cohere Rerank 3.5** | ~200ms | $0.002 | **Best** | No (API) |
| **Voyage Rerank 2** | ~100ms | $0.002 | Very Good | No (API) |
| **BGE Reranker v2** | ~150ms | **Free** | Good | Yes |
| **Jina Reranker v2** | ~120ms | $0.001 | Good | Yes |
| **ColBERT v2** | ~50ms | **Free** | Very Good | Yes (GPU) |

### Recommended Approach

**Primary:** Cohere Rerank 3.5 via API — best quality, simple integration.

**Fallback:** BGE Reranker v2 self-hosted — free, acceptable quality, no API dependency.

### Integration with SemanticSearchService

```
Query → VectorSearchProvider (top 100)  ┐
Query → PostgreSQL BM25 (top 100)       ├→ RRF merge (top 50) → Reranker (top 50 → 10)
                                         ┘
```

The reranker sits **after** RRF merge but **before** returning results to the user. This adds ~200ms to search latency but improves relevance by 15-25% (measured by NDCG@10 on newsletter content benchmarks).

**Cost at scale:** At 100 queries/user/month and $0.002/query:
- 1K users: $200/month
- 10K users: $2,000/month
- 100K users: $20,000/month

---

## 3. GraphRAG (Phase 2 — Day 60)

GraphRAG enhances retrieval by combining vector search with knowledge graph traversal. Instead of only finding "similar" documents, it can follow **relationships** between entities.

### How It Works

```
Traditional RAG:
  "What companies has Sam Altman invested in?"
  → Vector search → finds articles mentioning Sam Altman
  → May miss articles about companies where he's mentioned indirectly

GraphRAG:
  "What companies has Sam Altman invested in?"
  → Entity lookup: "Sam Altman" → entity node
  → Graph traversal: Sam Altman --[invested_in]--> Company A, Company B, ...
  → Retrieve content chunks linked to Company A, Company B
  → Synthesize with full relationship context
```

### Architecture Integration

GraphRAG builds on the `cross-document-intelligence` feature's entity relationship graph:

1. **Entities** extracted by `@arki/ai` StructuredGenerator → stored in Drizzle ORM `Entity` table
2. **Relationships** (subsidiary_of, competitor_of, led_by, etc.) → stored in `EntityRelationship` table
3. **Entity embeddings** → stored in VectorSearchProvider `avocabo_entities` collection
4. **Graph traversal** → Drizzle ORM multi-hop queries (start entity → relationships → connected entities → content chunks)

### Key Decision: Graph DB vs. PostgreSQL

| Approach | Multi-hop Queries | Operational Cost | Integration |
|----------|------------------|-----------------|-------------|
| **Neo4j / Neptune** | Excellent (native) | High ($200+/mo) | Separate system |
| **PostgreSQL recursive CTEs** | Good (3-4 hops) | Zero (existing DB) | Native Drizzle |
| **In-memory graph** | Excellent | RAM-dependent | Custom code |

**Recommendation:** Start with PostgreSQL recursive CTEs via Drizzle ORM. For Avocabo's scale (hundreds of entities per user, not millions), recursive CTEs handle 3-hop traversals in <50ms. Avoid adding a graph database until traversal latency exceeds 200ms or hop depth exceeds 4.

---

## 4. Agentic RAG (Phase 3 — Day 90)

Agentic RAG transforms search from a single query → result pattern into an iterative research process. The agent plans what to search, evaluates results, identifies gaps, and searches again until the question is thoroughly answered.

### Architecture

```
User question: "What are the risks to my AI startup based on my reading?"

Agent (Claude Opus 4.6 via @arki/ai Flow):
  Step 1: Decompose question into sub-queries
    → "AI startup risks 2026"
    → "regulatory changes AI"
    → "competitor funding rounds"

  Step 2: Execute searches via SemanticSearchService (with reranking)
    → Retrieve top-10 for each sub-query

  Step 3: Evaluate coverage
    → "Missing: talent market analysis"
    → Generate follow-up query: "AI talent hiring trends"

  Step 4: Execute follow-up search

  Step 5: Synthesize all results with citations
    → "Based on 15 sources from your library..."
```

### Cost Control

Agentic RAG is expensive — each query involves 2-5 retrieval steps plus a Lane 3 synthesis call. Budget controls are critical:

| Control | Implementation |
|---------|---------------|
| **Max retrieval steps** | Cap at 5 iterations per query |
| **Token budget** | Max 100K input tokens per agentic query |
| **Cost ceiling** | $0.10 per query (auto-degrade to simple search if exceeded) |
| **Daily limit** | 20 agentic queries per user (configurable in `@arki/kv`) |
| **Cache** | Cache synthesis in `@arki/kv` with 24-hour TTL, invalidate on new content |

### Integration with `@arki/ai` Flow

Agentic RAG is orchestrated by Flow with these nodes:

1. **Decompose** → break question into sub-queries (Lane 3)
2. **Search** → execute via SemanticSearchService (parallel sub-queries)
3. **Evaluate** → check coverage, identify gaps (Lane 2)
4. **FollowUp** → generate and execute additional searches (conditional loop)
5. **Synthesize** → combine all results with citations (Lane 3)

---

## 5. Advanced Retrieval Techniques

### Late Chunking

**Problem:** Traditional chunking splits articles into fixed-size chunks before embedding. Context at chunk boundaries is lost.

**Solution:** Store full articles. At query time, embed the query, then compare against full-article embeddings. Extract the most relevant **passages** from the full article dynamically.

| Aspect | Traditional Chunking | Late Chunking |
|--------|---------------------|---------------|
| Storage | More chunks, more embeddings | Fewer embeddings (1 per article) |
| Embedding cost | Higher (15 chunks per article) | Lower (1 per article) |
| Retrieval quality | Fixed boundaries, lost context | Dynamic extraction, full context |
| Query latency | Faster (pre-chunked) | Slower (extract at query time) |
| Best for | High-volume search | Complex questions, long articles |

**Recommendation:** Use traditional chunking for standard search (speed matters). Use late chunking for agentic search queries where quality > speed.

### ColBERT v2 (Per-Token Embeddings)

**Problem:** Single-vector embeddings compress an entire passage into one point. Multi-faceted queries ("AI companies doing open-source LLMs with good documentation") lose nuance.

**Solution:** ColBERT creates per-token embeddings for both query and document. The "MaxSim" operation finds the best token-level match, preserving multi-aspect query intent.

| Aspect | Single-Vector | ColBERT v2 |
|--------|--------------|------------|
| Storage | 1 vector/chunk | ~200 vectors/chunk |
| Quality | Good for simple queries | Excellent for complex queries |
| Latency | Fast (~10ms) | Moderate (~50ms with indexing) |
| Storage cost | Low | 200x higher per chunk |
| Best for | Most queries | Multi-aspect research queries |

**Recommendation:** Evaluate ColBERT v2 for the `ai-copilot` feature's research queries. Too storage-expensive for general search at scale.

---

## 6. Embedding Upgrade Summary

See [LLM Routing & Models](./LLM-ROUTING-AND-MODELS.md) Section 5 for full embedding model comparison. Key decisions:

| Phase | Current → Upgrade | Impact |
|-------|-------------------|--------|
| Phase 1 | OpenAI text-embedding-3-small → Voyage-3 | +5 MTEB points, -50% cost |
| Phase 2 | Add Nomic Embed Vision | Multimodal (images from VLM pipeline) |
| Phase 3 | Evaluate Matryoshka embeddings | 4x storage reduction for dedup |

---

## 7. Phased Evolution Roadmap

| Phase | Timeline | Upgrade | Impact | Cost Change |
|-------|----------|---------|--------|-------------|
| **1** | Day 30 | Add Cohere Rerank 3.5 after RRF | +15-25% relevance | +$0.002/query |
| **1** | Day 30 | Switch to Voyage-3 embeddings | +5 MTEB, -50% embed cost | -$0.04/1M tokens |
| **2** | Day 60 | GraphRAG for entity-aware queries | Relationship traversal | Minimal (PostgreSQL) |
| **2** | Day 60 | Add visual embeddings (Nomic) | Image/chart searchable | +$0.01/image |
| **3** | Day 90 | Agentic RAG via `@arki/ai` Flow | Multi-turn research | +$0.05-0.10/query |
| **3** | Day 90 | Late chunking for agentic queries | Better complex answers | Minimal |
| **Future** | Day 120+ | ColBERT v2 for copilot research | Multi-aspect precision | Significant storage |

---

## 8. Integration Points

### With `semantic-search` Feature

- Reranking layer added to SemanticSearchService after RRF merge
- Agentic search orchestrated by `@arki/ai` Flow (new `agenticSearch` node graph)
- Late chunking as alternative retrieval mode (toggled per query type)

### With `cross-document-intelligence` Feature

- GraphRAG uses existing entity/relationship graph
- Entity embeddings in VectorSearchProvider enable graph-aware retrieval
- Contradiction detection enhanced by multi-source retrieval

### With `ai-copilot` Feature

- Copilot research queries route through agentic RAG
- ColBERT v2 evaluation for multi-aspect queries
- Citation pipeline benefits from reranking (better source selection)

### With `@arki/queue`

- `search:reindex-embeddings` — batch job for embedding model migration
- `search:graph-index` — incremental entity graph updates
- `search:agentic-budget-reset` — daily reset of per-user agentic query budgets

---

## Sources

- Cohere Rerank: <https://docs.cohere.com/docs/reranking>
- Voyage Rerank: <https://docs.voyageai.com/docs/reranker>
- ColBERT v2: <https://github.com/stanford-futuredata/ColBERT>
- GraphRAG (Microsoft): <https://github.com/microsoft/graphrag>
- BGE Reranker: <https://huggingface.co/BAAI/bge-reranker-v2-m3>
- Jina Reranker: <https://jina.ai/reranker>
- MTEB leaderboard: <https://huggingface.co/spaces/mteb/leaderboard>
- Late Chunking (Jina): <https://jina.ai/news/late-chunking-in-long-context-embedding-models>
