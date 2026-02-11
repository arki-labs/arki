# State of the Art: Content Deduplication & Near-Duplicate Detection (2024-2026)

## Overview

Content deduplication identifies and handles duplicate or near-duplicate documents in a corpus. For Avocabo, where users subscribe to multiple newsletters that often cover the same stories, deduplication is critical for reducing noise and surfacing unique insights. This document surveys techniques from exact matching to semantic similarity detection.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 1997 | Broder's Shingling | Min-hash based near-duplicate detection |
| 2002 | SimHash (Charikar) | Locality-sensitive hashing for similarity |
| 2007 | Google dedup at scale | SimHash for web-scale document dedup |
| 2014 | Doc2Vec | Document-level embeddings for similarity |
| 2019 | Sentence-BERT | Efficient sentence embeddings for semantic similarity |
| 2022 | LLM-based dedup | GPT/Claude for nuanced duplicate detection |
| 2024 | Embedding dedup at scale | Vector search for efficient near-duplicate detection |
| 2025 | Semantic dedup + diff | Detect duplicates AND extract unique additions |
| 2026 | Cross-format dedup | Detect same story across newsletter, podcast, video |

### Paradigm Shifts

```
Exact Hash Matching (MD5/SHA, 1990s)
    ↓
Shingling + MinHash (approximate matching, 1997-2010s)
    ↓
SimHash / LSH (locality-sensitive hashing, 2002-2020s)
    ↓
Embedding Similarity (SBERT, dense vectors, 2019-2024)
    ↓
Semantic + Cross-Format Dedup (2025+)
```

## Current State

### Approach Comparison

| Approach | Exact Dupes | Near Dupes | Semantic Dupes | Cross-Format | Speed | Cost |
|----------|-------------|-----------|---------------|-------------|-------|------|
| Hash (MD5/SHA) | Perfect | None | None | None | <1ms | Free |
| Shingling + MinHash | Good | Good | None | None | ~5ms | Free |
| SimHash | Good | Good | Limited | None | ~2ms | Free |
| TF-IDF + cosine | Moderate | Good | Moderate | None | ~10ms | Free |
| Embedding similarity | Good | Excellent | Excellent | Partial | ~50ms | Embed cost |
| LLM-based | Good | Excellent | Excellent | Excellent | ~2s | ~$0.01/pair |

### What "Duplicate" Means for Newsletters

Newsletter deduplication is more nuanced than web dedup:

| Type | Example | Detection Difficulty |
|------|---------|---------------------|
| **Exact duplicate** | Same newsletter forwarded from 2 addresses | Easy (hash match) |
| **Reformatted duplicate** | Same content, different HTML template | Easy (text extraction → hash) |
| **Near-duplicate** | Same story, minor edits (typo fix, updated number) | Medium (MinHash/SimHash) |
| **Syndicated content** | Same article republished by different newsletters | Medium (embedding similarity) |
| **Same-story different-angle** | OpenAI news covered by Stratechery AND The Information | Hard (semantic) |
| **Cross-format duplicate** | Newsletter article + podcast discussing same story | Very Hard (cross-modal) |

**Key distinction:** "Same-story different-angle" is NOT a duplicate — it's complementary coverage. Avocabo should detect these pairs and link them for cross-document intelligence, not discard one.

## Architecture Patterns

### Multi-Stage Dedup Pipeline

```
New content arrives
  ↓
Stage 1: Exact dedup (hash)
  → SHA-256 of cleaned text → check against existing hashes
  → Match? → Discard (exact duplicate)
  ↓
Stage 2: Near-duplicate detection (embedding)
  → Generate embedding (Voyage-3 or similar)
  → VectorSearchProvider nearest-neighbor search (top-5, threshold > 0.92)
  → Match? → Mark as duplicate, link to original
  ↓
Stage 3: Same-story detection (semantic, lower threshold)
  → VectorSearchProvider search (threshold 0.78-0.92)
  → Match? → Link as "related coverage" (NOT deduplicated)
  ↓
Stage 4: Cross-format detection (optional)
  → Compare newsletter embedding against recent podcast/video embeddings
  → Match? → Link as cross-format coverage
```

### Dedup at Ingestion vs. Dedup at Retrieval

| Timing | Approach | Pros | Cons |
|--------|----------|------|------|
| **At ingestion** | Check new items against existing library | Prevents duplicates from entering | Miss duplicates from concurrent ingestion |
| **At retrieval** | Deduplicate search results | Always fresh, handles late-arriving dupes | Higher query latency |
| **Background batch** | Periodic full-library dedup scan | Catches everything | Delayed cleanup |
| **Hybrid (Avocabo)** | Ingestion check + periodic batch | Best coverage | Most complex |

## Key Technologies

### Hashing Techniques

| Technique | Granularity | Robustness | Speed |
|-----------|------------|------------|-------|
| MD5/SHA-256 | Exact match | None (any change breaks) | <1ms |
| MinHash (k=128) | Jaccard similarity | Robust to small edits | ~5ms |
| SimHash (64-bit) | Hamming distance | Robust to moderate changes | ~2ms |
| Content fingerprint | Normalized text hash | Robust to formatting | ~3ms |

### Embedding-Based Similarity

| Model | Dim | MTEB (retrieval) | Cost | Best For |
|-------|-----|-----------------|------|----------|
| Voyage-3 | 1024 | 67.3 | $0.06/1M | Highest quality dedup |
| text-embedding-3-small | 1536 | 62.3 | $0.02/1M | Cost-effective |
| Voyage-3-lite | 512 | 63.0 | $0.02/1M | Budget option |
| BGE-small-en | 384 | 51.7 | Free | Self-hosted |

### Similarity Thresholds (Calibrated for Newsletter Content)

| Threshold | Classification | Action |
|-----------|---------------|--------|
| > 0.98 | Exact/near-exact duplicate | Discard, keep one copy |
| 0.92-0.98 | Near-duplicate (minor edits, syndication) | Mark as duplicate, link |
| 0.78-0.92 | Same story, different angle | Link as related, surface in cross-doc intelligence |
| 0.60-0.78 | Same topic, different story | Cluster together (auto-clustering feature) |
| < 0.60 | Unrelated | No action |

**Calibration note:** These thresholds are specific to newsletter content. Code, academic papers, and social media posts require different thresholds.

## Advanced Techniques (2025-2026)

### Semantic Dedup with Diff Extraction

Don't just detect duplicates — extract what's unique:

```
Article A: "OpenAI announces GPT-5 with 1M context window and improved reasoning"
Article B: "OpenAI's GPT-5 launch includes 1M context, new safety features, and 3x speed"

Dedup result:
  Shared: GPT-5 launch, 1M context window
  Unique to A: improved reasoning focus
  Unique to B: safety features, 3x speed improvement
  → Keep both, but surface unique contributions in digest
```

**Implementation:** LLM-based diff (Lane 1) after embedding-based near-duplicate detection. Only for pairs with similarity 0.85-0.95.

### Cross-Format Deduplication

Same story appearing in newsletter, podcast, and YouTube video:

```
Newsletter: "OpenAI launches GPT-5..." (text, 800 words)
Podcast: "...talking about the GPT-5 launch today..." (transcript, 3000 words)
YouTube: "GPT-5 Review" (transcript + visual analysis)

Detection:
  → Extract key claims/entities from each format
  → Compare claim sets (not raw text, which differs significantly across formats)
  → Similarity at claim level > 0.80 → same story
  → Link all three, present as "multi-format coverage" in UI
```

### Dedup-Aware Clustering

Integrate deduplication signals into the auto-clustering pipeline:

```
Without dedup awareness:
  Cluster "AI News" has 20 items, but 8 are near-duplicates → inflated cluster

With dedup awareness:
  Cluster "AI News" has 12 unique items + 8 duplicates
  → Show "12 unique stories" in cluster header
  → Near-duplicates collapsed into "X sources covered this"
```

### Temporal Deduplication

The same topic may produce duplicate-seeming content over time:

```
January: "AI regulation debate heats up"
March: "AI regulation debate continues"  ← is this a duplicate?
June: "AI regulation bill passes"

→ NOT duplicates — temporal evolution of same story
→ Link as timeline: debate → continuation → resolution
```

**Detection:** Combine semantic similarity with publication date distance. High similarity + close dates = duplicate. High similarity + distant dates = story evolution.

## Evaluation Metrics

### Detection Quality

| Metric | Description | Target |
|--------|-------------|--------|
| Precision | % detected duplicates that are actual duplicates | >95% |
| Recall | % actual duplicates that are detected | >90% |
| F1 | Harmonic mean | >92% |
| False positive rate | Non-duplicates incorrectly flagged | <3% |

### User Impact

| Metric | Description |
|--------|-------------|
| Digest noise reduction | % fewer redundant items in digest after dedup |
| Unique content ratio | % of library items that are unique (not duplicate) |
| User override rate | How often users mark non-duplicates that were flagged |
| Cross-doc linkage quality | Are linked "related coverage" items actually about the same story? |

## Challenges and Limitations

1. **Threshold sensitivity:** A 0.01 change in similarity threshold can dramatically change dedup behavior. Requires careful calibration on newsletter-specific data.
2. **Same-story vs. same-topic:** "OpenAI launches GPT-5" and "AI industry analysis including GPT-5 mention" are different things. Semantic similarity alone can't always distinguish.
3. **Paraphrased content:** AI-rewritten content (common in newsletter curation) has low lexical overlap but high semantic similarity. Embedding-based detection is essential.
4. **Scale:** Comparing each new item against all existing items is O(n). VectorSearchProvider ANN search makes this O(log n) in practice.
5. **User expectations:** Some users want to see all coverage of a story (more is better). Others want strict dedup (less is better). Needs per-user configuration.
6. **Multi-language:** "La même histoire" and "The same story" are duplicates but share zero lexical overlap. Multilingual embeddings required.

## Best Practices for Avocabo

1. **Multi-stage pipeline** — hash for exact, embeddings for semantic, LLM for edge cases.
2. **Link, don't delete** — mark duplicates and hide from default view, but keep in library with link to canonical item.
3. **Calibrate thresholds on real data** — use a golden dataset of newsletter pairs with human labels.
4. **Distinguish duplicate from related** — 0.92+ is duplicate, 0.78-0.92 is related coverage (feed to cross-doc intelligence).
5. **Dedup at ingestion + batch cleanup** — catch most duplicates immediately, sweep for stragglers periodically.
6. **User configuration** — aggressive dedup (strict) vs. relaxed (show multiple perspectives) as a setting.

## References

1. Broder, A. (1997). "On the Resemblance and Containment of Documents"
2. Charikar, M. (2002). "Similarity Estimation Techniques from Rounding Algorithms (SimHash)"
3. Manku, G., Jain, A., & Das Sarma, A. (2007). "Detecting Near-Duplicates for Web Crawling"
4. Reimers, N., & Gurevych, I. (2019). "Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks"
5. Lee, K., et al. (2022). "Deduplicating Training Data Makes Language Models Better"
6. Abbas, A., et al. (2023). "SemDeDup: Data-efficient Learning at Web-scale through Semantic Deduplication"
