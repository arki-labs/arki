# State of the Art: Semantic Search & Information Retrieval (2024-2026)

## Overview

Semantic search has evolved from keyword matching to hybrid retrieval systems combining dense vector embeddings, sparse lexical signals, learned rerankers, and agentic multi-turn retrieval. This document surveys current techniques, architectures, and best practices relevant to Avocabo's search infrastructure.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 1999 | BM25 (Okapi) | Term frequency + inverse document frequency scoring |
| 2013 | Word2Vec | Dense word embeddings, semantic similarity |
| 2017 | Transformer architecture | Attention-based contextual representations |
| 2018 | BERT | Bidirectional pre-training, fine-tuning for retrieval |
| 2019 | Sentence-BERT (SBERT) | Efficient sentence embeddings via siamese networks |
| 2020 | Dense Passage Retrieval (DPR) | Bi-encoder dense retrieval at scale |
| 2021 | ColBERT | Per-token embeddings, late interaction for multi-aspect matching |
| 2022 | InstructOR / E5 | Instruction-tuned embeddings, task-aware retrieval |
| 2023 | RAG (Retrieval-Augmented Generation) | LLM + retrieval for grounded generation |
| 2024 | Hybrid search + reranking | Production-grade BM25 + vector + cross-encoder pipelines |
| 2025 | GraphRAG + Agentic RAG | Knowledge graph-enhanced and multi-turn iterative retrieval |
| 2026 | Late chunking, Matryoshka, multi-modal retrieval | Adaptive precision, dynamic passage extraction, image+text search |

### Paradigm Shifts

```
Keyword Matching (BM25, 1990s-2010s)
    ↓
Semantic Embeddings (Word2Vec, BERT, 2013-2020)
    ↓
Dense Retrieval (DPR, bi-encoders, 2020-2022)
    ↓
Hybrid Retrieval (BM25 + vector + reranking, 2022-2024)
    ↓
Agentic & Graph-Enhanced Retrieval (2025+)
```

## Current State of Semantic Search

### Approach Comparison

| Approach | Precision | Recall | Latency | Cost | Cold Start |
|----------|-----------|--------|---------|------|------------|
| BM25 (lexical) | Good (exact match) | Limited (no semantics) | <10ms | Free | Excellent |
| Dense vector (bi-encoder) | Good (semantics) | Good | ~20ms | Embedding cost | Requires data |
| Hybrid (BM25 + vector) | Very Good | Very Good | ~30ms | Moderate | Good |
| Hybrid + reranker | Excellent | Very Good | ~230ms | Higher | Good |
| ColBERT (late interaction) | Excellent | Excellent | ~50ms | High storage | Requires data |
| Agentic RAG (multi-turn) | Best (complex queries) | Best | 2-10s | Highest | Good |

### Embedding Model Leaderboard (MTEB, Feb 2026)

| Rank | Model | MTEB Average | Dimensions | Cost (1M tokens) |
|------|-------|-------------|------------|-------------------|
| 1 | Voyage-3 | 67.3 | 1024 | $0.06 |
| 2 | Cohere embed-v4 | 67.0 | 1024 | $0.10 |
| 3 | text-embedding-3-large | 64.6 | 3072 | $0.13 |
| 4 | Jina Embeddings v3 | 64.0 | 1024 | $0.02 |
| 5 | text-embedding-3-small | 62.3 | 1536 | $0.02 |
| 6 | BGE-large-en-v1.5 | 63.6 | 1024 | Free (self-hosted) |

### Reranker Leaderboard (Feb 2026)

| Rank | Model | NDCG@10 Improvement | Latency (50 docs) | Cost |
|------|-------|--------------------|--------------------|------|
| 1 | Cohere Rerank 3.5 | +15-25% | ~200ms | $0.002/query |
| 2 | Voyage Rerank 2 | +12-20% | ~100ms | $0.002/query |
| 3 | BGE Reranker v2-M3 | +10-18% | ~150ms | Free (self-hosted) |
| 4 | Jina Reranker v2 | +10-15% | ~120ms | $0.001/query |

## Architecture Patterns

### Classic Hybrid Search (Current Best Practice)

```
Query
  → BM25 sparse retrieval (top 100)        ┐
  → Dense vector retrieval (top 100)        ├→ Reciprocal Rank Fusion → Top 50
                                             ┘
  → Cross-encoder reranker (top 50 → 10)
  → Results with scores
```

### RAG Pipeline

```
User question
  → Query encoder → embedding
  → Retrieval (hybrid search) → top-K passages
  → Prompt: [system] + [retrieved passages] + [question]
  → LLM → answer with citations
```

### Agentic RAG (Emerging)

```
User question
  → Query planner (LLM): decompose into sub-queries
  → For each sub-query:
      → Retrieval (hybrid + rerank)
      → Evaluate coverage
  → If gaps detected:
      → Generate follow-up queries
      → Additional retrieval rounds
  → Synthesize all results with citations
```

### GraphRAG (Emerging)

```
User question: "What companies has X invested in?"
  → Entity extraction: identify "X" as entity
  → Graph traversal: X → [invested_in] → Companies
  → For each company:
      → Retrieve related content chunks
  → Synthesize with relationship context
```

## Key Technologies

### Chunking Strategies

| Strategy | Chunk Size | Overlap | Best For |
|----------|-----------|---------|----------|
| Fixed-size | 200-500 tokens | 50-100 tokens | General purpose |
| Sentence-based | Variable | Sentence boundary | Short-form content |
| Paragraph-based | Variable | None | Well-structured docs |
| Semantic | Variable | None | Long-form, mixed content |
| Late chunking | Full document | N/A | Complex queries (query-time) |

### Vector Databases / Search Providers

| Provider | Type | Strengths | Hybrid Search |
|----------|------|-----------|---------------|
| Qdrant | Dedicated vector DB | Filtering, quantization | Built-in (sparse+dense) |
| Pinecone | Managed cloud | Ease of use, scale | Built-in (hybrid) |
| Weaviate | Dedicated vector DB | GraphQL, modules | Built-in |
| pgvector | PostgreSQL extension | No new infra | BM25 via tsvector |
| Milvus | Distributed vector DB | Scale, GPU acceleration | Sparse vectors |

### Fusion Methods

| Method | Description | Pros | Cons |
|--------|-------------|------|------|
| RRF (Reciprocal Rank Fusion) | 1/(k+rank) weighted sum | Simple, robust, no tuning | Equal weight assumption |
| Weighted Linear | score = α·vector + (1-α)·bm25 | Tunable | Requires score normalization |
| Learned fusion | ML model combines scores | Optimal | Requires training data |

## Advanced Techniques (2025-2026)

### Matryoshka Representation Learning (MRL)

Embeddings trained so that truncated prefixes remain useful. A 1024-dim embedding can be truncated to 256-dim for approximate search, then full dimensions used for reranking. Reduces storage 4x with minimal quality loss.

```
Full embedding (1024d) → Exact search
Truncated (256d)       → Approximate retrieval (4x less storage)
Truncated (64d)        → Deduplication, fast comparison (16x less storage)
```

**Status:** Supported by OpenAI text-embedding-3, Nomic, and Cohere embed-v4.

### Late Chunking

Instead of pre-computing chunk embeddings, store full documents and compute embeddings at query time. The model processes the full document context, then extracts passage-level embeddings informed by the whole article.

**Trade-off:** Better context preservation for complex queries, but higher query latency and compute cost.

**Status:** Proposed by Jina AI (2024), adopted by some enterprise systems. Best suited for agentic/research queries, not real-time search.

### ColBERT v2 (Per-Token Retrieval)

Every token in query and document gets its own embedding. Matching uses "MaxSim" — for each query token, find the best-matching document token and sum scores. This preserves multi-aspect query intent.

**Trade-off:** 200x more storage per document, but significantly better precision for complex queries.

**Status:** Production-ready (Stanford PLAID index, RAGatouille wrapper). Best for research-heavy use cases.

### Multi-Modal Embeddings

Unified embedding space for text, images, and (increasingly) audio. Enables searching across content types — "find charts about revenue growth" returns both text passages and chart images.

| Model | Modalities | Dimensions | Cost |
|-------|-----------|------------|------|
| Nomic Embed Vision | Text + Image | 768 | Free (self-hosted) |
| Jina CLIP v2 | Text + Image | 1024 | $0.02/1M tokens |
| Voyage Multimodal | Text + Image | 1024 | $0.06/1M tokens |

### Query Expansion and Reformulation

LLM-powered query expansion generates synonyms and related terms to improve recall:

```
Original: "database optimization"
Expanded: "database optimization, SQL performance tuning, query optimization,
           index strategy, database scaling, query execution plan"
```

**Risk:** Expansion can drift off-topic. Limit to 3-5 expansion terms. Use fast model (Lane 1) to minimize cost.

## Evaluation Metrics

### Retrieval Quality

| Metric | Description | When to Use |
|--------|-------------|-------------|
| NDCG@K | Normalized discounted cumulative gain | Ranked result quality |
| Recall@K | Fraction of relevant docs in top-K | Coverage assessment |
| MRR | Mean reciprocal rank of first relevant | Single-intent queries |
| MAP | Mean average precision | Multiple relevant docs |
| Hit Rate@K | Any relevant doc in top-K | Basic relevance check |

### RAG-Specific Metrics

| Metric | Description | How Measured |
|--------|-------------|-------------|
| Answer correctness | Does the answer match ground truth? | LLM-as-judge |
| Faithfulness | Is the answer supported by retrieved context? | Citation verification |
| Relevance | Are retrieved passages relevant to the query? | LLM-as-judge or human |
| Hallucination rate | % claims not supported by context | Automated source matching |

## Challenges and Limitations

### Current Challenges

1. **Semantic drift**: "Apple" returns both tech company and fruit. Hybrid search partially mitigates; entity disambiguation helps more.
2. **Long-tail queries**: Rare topics may not have enough data for good embeddings. Query expansion and agentic follow-up help.
3. **Cross-lingual retrieval**: Multilingual embeddings are improving but still lag monolingual quality.
4. **Temporal reasoning**: "Latest developments in AI" requires understanding time, not just semantics.
5. **Multi-hop reasoning**: "Companies that compete with startups founded by ex-Googlers" requires graph traversal + retrieval.
6. **Evaluation at scale**: Manual relevance judgments are expensive. LLM-as-judge is cheaper but can be inconsistent.

## Emerging Trends

### 1. Retrieval as a Service

Dedicated retrieval APIs (Exa, Perplexity Sonar, Tavily) combine search, extraction, and ranking into single API calls. Useful for agentic RAG follow-up steps.

### 2. Speculative Retrieval

Pre-fetch likely-needed documents based on conversation context, before the user asks. Reduces perceived latency in conversational search.

### 3. Personalized Retrieval

User-specific relevance models that learn from click-through and engagement data. The same query returns different results for different users based on their interests and reading history.

### 4. Streaming Search Results

Return results progressively as they're found and ranked, rather than waiting for the full pipeline. Improves perceived responsiveness.

## Best Practices for Avocabo

1. **Hybrid search is table stakes**: BM25 + vector + RRF is the minimum viable retrieval stack.
2. **Reranking is the highest-ROI upgrade**: 15-25% relevance improvement for ~$0.002/query.
3. **Invest in chunking quality**: Good chunk boundaries matter more than embedding model choice.
4. **Evaluate continuously**: NDCG@10 on a golden dataset, tracked per model/prompt change.
5. **Phase upgrades**: Reranking (Phase 1) → GraphRAG (Phase 2) → Agentic RAG (Phase 3).
6. **Budget agentic queries**: Multi-turn retrieval is 10-50x more expensive than simple search.

## References

1. Robertson, S., & Zaragoza, H. (2009). "The Probabilistic Relevance Framework: BM25 and Beyond"
2. Karpukhin, V., et al. (2020). "Dense Passage Retrieval for Open-Domain Question Answering"
3. Khattab, O., & Zaharia, M. (2020). "ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction"
4. Lewis, P., et al. (2020). "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"
5. Wang, L., et al. (2022). "Text Embeddings by Weakly-Supervised Contrastive Pre-training (E5)"
6. Kusupati, A., et al. (2022). "Matryoshka Representation Learning"
7. Edge, D., et al. (2024). "From Local to Global: A Graph RAG Approach to Query-Focused Summarization"
8. Cormack, G., Clarke, C., & Buettcher, S. (2009). "Reciprocal Rank Fusion Outperforms Condorcet and Individual Rank Learning Methods"
