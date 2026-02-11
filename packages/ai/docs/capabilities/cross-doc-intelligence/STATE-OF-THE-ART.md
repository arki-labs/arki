# State of the Art: Cross-Document Intelligence (2024-2026)

## Overview

Cross-document intelligence encompasses entity resolution, knowledge graph construction, multi-document summarization, contradiction detection, and trend analysis across large document collections. This field sits at the intersection of information extraction, knowledge representation, and LLM-powered synthesis. This document surveys techniques relevant to Avocabo's cross-document intelligence feature.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 2001 | Coreference resolution (MUC-7) | Entity mention linking within/across documents |
| 2005 | TAC Knowledge Base Population | Structured extraction from unstructured text |
| 2010 | Google Knowledge Graph | Large-scale entity relationship graphs |
| 2014 | Knowledge graph embeddings (TransE) | Embedding entities and relations in vector space |
| 2017 | Transformer NER | BERT-based named entity recognition |
| 2019 | Entity linking (BLINK) | Dense retrieval for entity disambiguation |
| 2020 | Multi-document summarization (PRIMERA) | Transformer-based cross-doc synthesis |
| 2022 | LLM entity extraction | GPT/Claude for zero-shot NER and relation extraction |
| 2023 | LLM synthesis + RAG | Retrieval-augmented cross-document summarization |
| 2024 | GraphRAG | Knowledge graph-enhanced retrieval and synthesis |
| 2025 | Agentic cross-document analysis | Multi-agent systems for contradiction detection and trend synthesis |
| 2026 | Temporal knowledge graphs | Time-aware entity tracking and claim evolution |

### Paradigm Shifts

```
Rule-Based IE (patterns, regex, 1990s-2005)
    ↓
Statistical NER/RE (CRFs, SVMs, 2005-2017)
    ↓
Neural NER/RE (BERT, SpanBERT, 2017-2022)
    ↓
LLM-Powered Extraction (zero-shot, structured output, 2022-2024)
    ↓
Agentic Knowledge Systems (graph + LLM + retrieval, 2025+)
```

## Current State

### Entity Extraction Approaches

| Approach | Precision | Recall | Speed | Cost | Best For |
|----------|-----------|--------|-------|------|----------|
| SpaCy NER | Good | Good | Very Fast | Free | High-volume, standard entities |
| BERT-based NER (fine-tuned) | Very Good | Very Good | Fast | Free (self-hosted) | Domain-specific entities |
| LLM zero-shot extraction | Excellent | Good | Slow | ~$0.01/doc | Complex, novel entity types |
| LLM structured extraction | Excellent | Very Good | Slow | ~$0.02/doc | Structured output with relations |
| Hybrid (SpaCy + LLM) | Excellent | Excellent | Moderate | ~$0.005/doc | Best accuracy at reasonable cost |

### Entity Resolution / Disambiguation

| Technique | Accuracy | Speed | Description |
|-----------|----------|-------|-------------|
| String matching (fuzzy) | Moderate | Very Fast | Levenshtein distance, Jaccard similarity |
| Embedding similarity | Good | Fast | Compare entity mention embeddings |
| Context-based disambiguation | Very Good | Moderate | Use surrounding text to disambiguate |
| LLM-based resolution | Excellent | Slow | "Is 'Apple' in this context a company or fruit?" |
| Knowledge base linking | Very Good | Fast | Link to Wikidata/DBpedia entities |

### Relationship Extraction

| Approach | Types | Quality | Cost |
|----------|-------|---------|------|
| Rule-based patterns | Fixed set | Moderate | Free |
| Supervised RE (BERT) | Fixed set | Good | Training cost |
| OpenIE (open extraction) | Open-ended | Moderate | Free |
| LLM structured extraction | Fixed or open | Excellent | ~$0.01/doc |
| LLM + validation | Fixed or open | Best | ~$0.02/doc |

## Architecture Patterns

### Knowledge Graph Construction Pipeline

```
Documents
  → Entity Extraction (NER + LLM)
  → Entity Resolution (embedding similarity + LLM disambiguation)
  → Relationship Extraction (LLM structured output)
  → Graph Storage (PostgreSQL or Graph DB)
  → Graph Embedding (optional, for graph-based retrieval)
```

### Multi-Document Summarization

| Pattern | Input | Output | When to Use |
|---------|-------|--------|-------------|
| Extractive | Multiple docs → select key sentences | Sentence compilation | Quick overview |
| Abstractive (map-reduce) | Each doc → summary → combine summaries | Merged synthesis | Medium collections |
| Abstractive (stuff) | All docs → single LLM call | Unified synthesis | Small collections (<50K tokens) |
| Hierarchical | Chunk → summarize → cluster → synthesize | Multi-level overview | Large collections |
| RAG-based | Question + retrieval → synthesis | Focused answer | Specific questions |

### Contradiction Detection

```
Claim A: "Company X revenue grew 25% in Q4" (Source: Newsletter 1)
Claim B: "Company X reported flat revenue in Q4" (Source: Newsletter 2)

Detection pipeline:
  1. Extract claims from each source (LLM structured output)
  2. Cluster related claims by entity + topic
  3. Compare claim pairs:
     → Embedding similarity (find candidates)
     → LLM-as-judge: "Are these claims contradictory?"
     → Classify: agreement / disagreement / different aspect / temporal change
  4. Score contradiction confidence (0-1)
  5. Present high-confidence contradictions to user
```

### Trend Analysis

```
Time series of entity mentions:
  Week 1: "AI Safety" mentioned in 2 sources
  Week 2: "AI Safety" mentioned in 5 sources
  Week 3: "AI Safety" mentioned in 12 sources → TREND DETECTED

Detection:
  → Track mention frequency per entity per time window
  → Z-score against rolling baseline
  → Filter: z > 2 AND absolute count > 3
  → Sentiment tracking: is coverage becoming more positive/negative?
```

## Key Technologies

### Knowledge Graph Storage Options

| Storage | Query Language | Multi-Hop | Best For |
|---------|--------------|-----------|----------|
| **PostgreSQL + Drizzle ORM** | SQL (recursive CTEs) | 3-4 hops | Small-medium graphs, existing infra |
| **Neo4j** | Cypher | Unlimited | Large graphs, complex traversals |
| **Amazon Neptune** | Gremlin/SPARQL | Unlimited | Managed, enterprise |
| **TypeDB** | TypeQL | Unlimited | Schema-rich, inference |
| **In-memory (NetworkX)** | Python API | Unlimited | Analysis, small graphs |

### Knowledge Graph Embedding Models

| Model | Approach | Best For |
|-------|----------|----------|
| TransE | Translation-based | Simple relations |
| RotatE | Rotation-based | Symmetric/antisymmetric relations |
| ComplEx | Complex-valued | All relation types |
| GraphSAGE | Message passing | Inductive (new nodes) |

### LLM-as-Judge for Quality

| Task | Judge Model | Prompt Pattern |
|------|-------------|---------------|
| Entity accuracy | Haiku 4.5 (Lane 1) | "Is [entity] correctly extracted from [context]?" |
| Relation accuracy | Sonnet 4.5 (Lane 2) | "Does [source] support the relation [A] --[rel]--> [B]?" |
| Synthesis faithfulness | Sonnet 4.5 (Lane 2) | "Is every claim in [synthesis] supported by [sources]?" |
| Contradiction confidence | Opus 4.6 (Lane 3) | "Are claims [A] and [B] genuinely contradictory?" |

## Advanced Techniques (2025-2026)

### GraphRAG (Microsoft Research)

Combines knowledge graph construction with retrieval-augmented generation:

1. **Indexing:** Extract entities and relationships → build graph → create community summaries at multiple levels
2. **Local search:** Start from query-relevant entities → traverse graph → retrieve connected content
3. **Global search:** Use community summaries for broad, thematic questions

**Trade-off:** Expensive indexing phase (entity extraction + graph construction), but excellent retrieval for relationship queries.

**Relevance for Avocabo:** Powers "Find all funding announcements for AI companies I follow" and "How has coverage of [company] changed over time?"

### Temporal Knowledge Graphs

Track entity properties and relationships as they change over time:

```
Entity: "OpenAI"
  2024-Q1: CEO = Sam Altman, Valuation = $80B, Status = Non-profit → for-profit transition
  2024-Q4: CEO = Sam Altman, Valuation = $157B, Status = For-profit
  2025-Q3: CEO = Sam Altman, Valuation = $300B, Products = [GPT-5, o3, Sora 2]
```

**Implementation:** Drizzle ORM tables with `valid_from` / `valid_to` temporal columns. Entity snapshots stored weekly.

### Claim Tracking Across Sources

Go beyond single-document extraction to track how claims propagate and evolve across sources:

```
Original claim: "Company X planning IPO in 2026" (Source: WSJ, Jan 15)
Corroboration: "X reportedly files S-1" (Source: TechCrunch, Feb 2)
Contradiction: "X delays IPO plans" (Source: Bloomberg, Feb 20)
Resolution: "X confirms IPO postponed to 2027" (Source: X press release, Mar 1)
```

**Status:** Emerging research area. Requires temporal reasoning + claim extraction + source linking. LLM-powered but expensive.

### Source Credibility Scoring

Weight synthesis outputs by source reliability:

```
Source A (established publication, high historical accuracy): weight = 0.9
Source B (opinion blog, mixed track record): weight = 0.6
Source C (PR press release, inherently biased): weight = 0.3

Synthesis weighted by source credibility:
  "According to [A, high confidence], revenue grew 25%.
   Note: [C, lower confidence] claims 35% growth, likely inflated."
```

**Ethical consideration:** Displaying credibility scores publicly could be perceived as judging journalists. Use internally for weighting, show to users only as "confidence levels."

## Evaluation Metrics

### Entity Extraction Quality

| Metric | Description |
|--------|-------------|
| Precision | % extracted entities that are correct |
| Recall | % of real entities that were extracted |
| F1 | Harmonic mean of precision and recall |
| Entity linking accuracy | % of entities linked to correct canonical form |

### Synthesis Quality

| Metric | Description | Measurement |
|--------|-------------|-------------|
| Faithfulness | All claims supported by sources | LLM-as-judge + source matching |
| Coverage | Key information from all sources included | LLM-as-judge with checklist |
| Coherence | Reads as a unified narrative | LLM-as-judge + readability score |
| Citation accuracy | Citations point to correct sources | Automated source verification |
| Contradiction detection precision | Flagged contradictions are real | Human evaluation sample |

## Challenges and Limitations

1. **Entity ambiguity at scale:** With 500+ entities per user, disambiguation errors compound. "Apple" is easy; "Mercury" (planet, element, car brand, Roman god) is harder.
2. **Relationship hallucination:** LLMs sometimes infer relationships not explicitly stated. "Article mentions both X and Y" ≠ "X and Y are related."
3. **Temporal reasoning:** "X announced layoffs" in January vs. March may refer to different events. Temporal deduplication is hard.
4. **Synthesis staleness:** Pre-computed synthesis becomes stale when new items arrive. Invalidation strategy must balance freshness vs. compute cost.
5. **Cross-lingual entities:** Same entity in different languages (e.g., English and German newsletters) requires multilingual entity linking.
6. **Privacy in shared contexts:** Entity graphs could inadvertently reveal reading patterns. Per-user isolation is essential.

## Best Practices for Avocabo

1. **Hybrid NER:** Use SpaCy for fast initial extraction, LLM for validation and complex entity types.
2. **Start with PostgreSQL:** Recursive CTEs handle 3-4 hop queries well for per-user graphs. Avoid graph DB until proven insufficient.
3. **Batch entity resolution:** Run dedup/merge as a background job, not inline during ingestion.
4. **Cache synthesis aggressively:** TTL-based caching in `@arki/kv`, invalidate when cluster membership changes.
5. **Track claim provenance:** Every extracted fact must link back to its source document and passage.
6. **Phase rollout:** Entity extraction (Phase 1) → Relationship graph (Phase 2) → Synthesis + contradictions (Phase 3).

## References

1. Edge, D., et al. (2024). "From Local to Global: A Graph RAG Approach to Query-Focused Summarization"
2. Fang, Y., et al. (2023). "Universal Information Extraction as Generative Language Model"
3. Wu, L., et al. (2020). "BLINK: Entity Linking via Dense Retrieval"
4. Xiao, C., et al. (2022). "Training Data is More Valuable than You Think: A Simple and Effective Method by Retrieving from Training Data"
5. Liu, Y., et al. (2022). "PRIMERA: Pyramid-based Masked Sentence Pre-training for Multi-document Summarization"
6. Laban, P., et al. (2022). "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization"
7. Ji, Z., et al. (2023). "Survey of Hallucination in Natural Language Generation"
8. Bordes, A., et al. (2013). "Translating Embeddings for Modeling Multi-relational Data (TransE)"
