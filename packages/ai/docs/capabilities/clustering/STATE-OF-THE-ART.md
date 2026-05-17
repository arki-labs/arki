# State of the Art: Document Clustering & Topic Modeling (2024-2026)

## Overview

Document clustering has evolved from simple bag-of-words approaches to neural topic models and embedding-based clustering. Modern systems combine dense embeddings with hierarchical clustering algorithms, dimensionality reduction, and LLM-powered topic labeling. This document surveys techniques relevant to Avocabo's auto-clustering feature.

## Historical Context

### Evolution Timeline

| Year | Milestone                         | Key Innovation                                                            |
| ---- | --------------------------------- | ------------------------------------------------------------------------- |
| 1998 | K-Means + TF-IDF                  | Statistical clustering on term frequencies                                |
| 2003 | Latent Dirichlet Allocation (LDA) | Probabilistic topic modeling                                              |
| 2013 | Word2Vec clustering               | Dense word embeddings + K-Means                                           |
| 2017 | Doc2Vec clustering                | Document-level embeddings                                                 |
| 2018 | UMAP + HDBSCAN                    | Dimensionality reduction + density-based clustering                       |
| 2019 | Top2Vec                           | Jointly learns topic embeddings and document embeddings                   |
| 2022 | BERTopic                          | Transformer embeddings + UMAP + HDBSCAN + c-TF-IDF                        |
| 2023 | LLM-powered topic naming          | GPT/Claude for human-readable cluster labels                              |
| 2024 | Dynamic BERTopic                  | Online topic modeling for streaming data                                  |
| 2025 | Embedding-first + LLM-hybrid      | Production systems combining embedding clustering with LLM interpretation |
| 2026 | Multi-modal clustering            | Clustering across text, images, and audio content                         |

### Paradigm Shifts

```
Statistical (TF-IDF + K-Means, 1990s-2010s)
    ↓
Probabilistic (LDA, NMF, 2003-2017)
    ↓
Embedding-based (Doc2Vec, 2017-2019)
    ↓
Neural Topic Models (BERTopic, Top2Vec, 2019-2023)
    ↓
LLM-Enhanced Clustering (2024+)
```

## Current State of Document Clustering

### Approach Comparison

| Approach         | Quality   | Scalability | Interpretability     | Dynamic         | Cold Start |
| ---------------- | --------- | ----------- | -------------------- | --------------- | ---------- |
| LDA              | Moderate  | Excellent   | Good (word lists)    | Online LDA      | Moderate   |
| K-Means + TF-IDF | Moderate  | Excellent   | Limited              | Re-cluster      | Good       |
| Top2Vec          | Good      | Good        | Good                 | Limited         | Good       |
| BERTopic         | Very Good | Good        | Very Good (c-TF-IDF) | Dynamic variant | Good       |
| UMAP + HDBSCAN   | Very Good | Moderate    | Requires labeling    | Re-cluster      | Good       |
| LLM-enhanced     | Excellent | Limited     | Excellent            | Per-batch       | Excellent  |

### BERTopic (Current Best Practice)

BERTopic is the dominant open-source approach for production topic modeling:

```
Documents → Embedding model → UMAP (reduce dims) → HDBSCAN (cluster) → c-TF-IDF (topics)
              ↓                    ↓                    ↓                   ↓
         SBERT/Voyage        2D/5D projection     Density clusters    Topic keywords
```

**Key strengths:**

- Works with any embedding model (swap Voyage-3, OpenAI, etc.)
- HDBSCAN finds clusters of varying density without specifying K
- c-TF-IDF creates interpretable topic representations
- Dynamic BERTopic handles streaming data (new documents over time)
- Hierarchical topic modeling for multi-granularity

### Framework Comparison

| Framework                         | Language | Embedding     | Clustering     | Labeling           | Production-Ready |
| --------------------------------- | -------- | ------------- | -------------- | ------------------ | ---------------- |
| **BERTopic**                      | Python   | Any           | HDBSCAN        | c-TF-IDF + LLM     | Yes              |
| **Top2Vec**                       | Python   | Doc2Vec/SBERT | HDBSCAN        | Centroid words     | Moderate         |
| **Scikit-learn**                  | Python   | TF-IDF        | K-Means/DBSCAN | Manual             | Yes (basic)      |
| **Gensim LDA**                    | Python   | Bag-of-words  | Probabilistic  | Word distributions | Yes              |
| **Custom (embeddings + cluster)** | Any      | Voyage/OpenAI | Any algorithm  | LLM-generated      | Flexible         |

## Architecture Patterns

### Batch Clustering (Periodic Re-clustering)

```
Every N hours:
  All user documents → Embed → UMAP → HDBSCAN → Assign clusters
  New clusters → LLM naming
  Changed clusters → Detect merges/splits → Update memberships
```

**Pros:** Globally optimal clusters, simple implementation.
**Cons:** Doesn't react to new items in real-time, expensive for large libraries.

### Online Clustering (Incremental Assignment)

```
New document arrives:
  → Embed document
  → Compare to existing cluster centroids
  → If similarity > threshold → assign to nearest cluster
  → If no match → add to buffer
  → Periodically: re-cluster buffer + existing clusters
```

**Pros:** Real-time assignment, responsive UX.
**Cons:** Centroid drift, may create suboptimal assignments.

### Hybrid Approach (Avocabo's Design)

```
Real-time: New item → VectorSearchProvider centroid matching → assign if > 0.75 similarity
Batch (every 4 hours): Full HDBSCAN via Python sidecar → re-cluster, merge, split
LLM labeling: Sonnet 4.5 generates human-readable cluster names
```

## Key Technologies

### Dimensionality Reduction

| Method        | Speed    | Preservation             | Best For              |
| ------------- | -------- | ------------------------ | --------------------- |
| UMAP          | Moderate | Local + global structure | BERTopic pipeline     |
| t-SNE         | Slow     | Local structure only     | Visualization         |
| PCA           | Fast     | Global variance          | Pre-processing        |
| Truncated SVD | Fast     | Global variance          | Large sparse matrices |

### Clustering Algorithms

| Algorithm     | Requires K?        | Handles Noise? | Varying Density? | Complexity  |
| ------------- | ------------------ | -------------- | ---------------- | ----------- |
| **HDBSCAN**   | No                 | Yes            | Yes              | O(n log n)  |
| K-Means       | Yes                | No             | No               | O(n·k·i)    |
| DBSCAN        | No (needs epsilon) | Yes            | No               | O(n log n)  |
| Agglomerative | Optional           | No             | Partial          | O(n² log n) |
| Spectral      | Yes                | No             | Yes              | O(n³)       |

### Cluster Naming Strategies

| Strategy                       | Quality    | Cost            | Speed  |
| ------------------------------ | ---------- | --------------- | ------ |
| Top-N keywords (c-TF-IDF)      | Moderate   | Free            | Fast   |
| LLM-generated from sample      | Excellent  | ~$0.003/cluster | ~2s    |
| LLM-generated from all items   | Excellent+ | ~$0.01/cluster  | ~5s    |
| User-defined (manual override) | Perfect    | Free            | Manual |

## Advanced Techniques (2025-2026)

### Hierarchical Topic Modeling

Multi-level clustering where broad topics contain narrower sub-topics:

```
Level 0: Technology
  Level 1: AI & Machine Learning
    Level 2: Large Language Models
      Level 3: GPT-5 Specifically
```

**Implementation:** HDBSCAN with `min_cluster_size` at different levels, or BERTopic's hierarchical merge.

**Relevance for Avocabo:** Users can explore clusters at their preferred granularity — broad overview or drill-down into specifics.

### Dynamic Topic Modeling (Temporal Evolution)

Track how topics evolve over time:

```
Week 1: "AI Safety" (5 items)
Week 2: "AI Safety" (8 items, new subtopic: "AI Regulation")
Week 3: "AI Safety" merges with "AI Regulation" → "AI Governance" (15 items)
```

**Implementation:** BERTopic's dynamic variant, or custom tracking with cluster centroid drift detection.

**Relevance for Avocabo:** Show users how their reading interests evolve. "Your coverage of AI governance has increased 3x this month."

### Multi-Modal Clustering

Cluster documents based on text content + visual elements (charts, images) + audio features:

```
Newsletter with chart → text embedding + chart embedding → joint cluster
Podcast transcript + show notes → audio features + text embedding → joint cluster
```

**Status:** Early stage. Nomic Embed Vision and Jina CLIP v2 enable text+image joint embeddings. Audio clustering is less mature.

### LLM-Enhanced Cluster Quality

Use LLMs not just for naming, but for cluster validation:

```
Cluster "AI Infrastructure" with 12 items:
  → LLM reviews member list
  → Identifies outliers: "This article about kitchen appliances doesn't belong"
  → Suggests splits: "Consider separating Cloud Infrastructure from AI Hardware"
```

**Cost:** ~$0.01 per cluster validation. Run during batch re-clustering, not real-time.

## Evaluation Metrics

### Internal Metrics (No Ground Truth)

| Metric            | Description                              | Interpretation            |
| ----------------- | ---------------------------------------- | ------------------------- |
| Silhouette score  | Cohesion vs. separation                  | Higher = better (-1 to 1) |
| Calinski-Harabasz | Ratio of between/within cluster variance | Higher = better           |
| Davies-Bouldin    | Average similarity of clusters           | Lower = better            |
| Noise ratio       | % items not assigned                     | Lower = more inclusive    |

### External Metrics (With Ground Truth)

| Metric                        | Description                 | Use Case                         |
| ----------------------------- | --------------------------- | -------------------------------- |
| Adjusted Rand Index           | Agreement with human labels | Gold standard evaluation         |
| Normalized Mutual Information | Information overlap         | Comparing cluster configurations |
| Cluster purity                | % items correctly assigned  | Quality monitoring               |

### User-Centric Metrics

| Metric                 | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| Rename rate            | How often users rename AI-generated cluster labels    |
| Manual override rate   | How often users move items between clusters           |
| Engagement per cluster | Click-through rate on cluster-grouped digest sections |
| Cluster discovery rate | % of clusters users explore beyond default view       |

## Challenges and Limitations

1. **Optimal granularity is subjective:** One user wants "Technology" (broad), another wants "GPU Architecture" (narrow). No single clustering serves all users.
2. **Cold start:** With <20 items, clustering is unreliable. Need heuristic fallbacks (source-based grouping).
3. **Noise handling:** Items that don't fit any cluster (HDBSCAN noise points) frustrate users expecting organization.
4. **Centroid drift:** As clusters grow, the centroid may no longer represent the cluster well. Periodic recomputation is necessary.
5. **Multi-membership:** An article about "AI regulation in the EU" belongs to both "AI" and "EU Policy" clusters. Managing overlap in the UI is a UX challenge.
6. **Scale:** HDBSCAN on 10K+ items per user becomes slow. Approximate methods or pre-filtering needed.

## Best Practices for Avocabo

1. **Start with UMAP + HDBSCAN** (via Python sidecar) — best balance of quality and flexibility. Python is an intentional exception to the Bun-first stack: HDBSCAN, UMAP, and BERTopic depend on numpy/scipy/scikit-learn with no mature JS equivalents. The sidecar runs as a lightweight HTTP service called from `@arki/ai` via `@arki/resilience`, deployed alongside the main Bun process.
2. **Use LLM naming** (Sonnet 4.5) — c-TF-IDF keywords are useful for debugging but not user-facing.
3. **Hybrid real-time + batch** — real-time centroid assignment for immediate feedback, batch re-clustering for global optimization.
4. **Expose granularity controls** — let users zoom in/out on cluster hierarchy.
5. **Track user corrections** — manual renames and moves are the best signal for improving cluster quality.
6. **Cap visible clusters** — show 5-8 in digest, with "Show all" for power users.

## References

1. Grootendorst, M. (2022). "BERTopic: Neural topic modeling with a class-based TF-IDF procedure"
2. McInnes, L., Healy, J., & Astels, S. (2017). "hdbscan: Hierarchical density based clustering"
3. McInnes, L., Healy, J., & Melville, J. (2018). "UMAP: Uniform Manifold Approximation and Projection for Dimension Reduction"
4. Angelov, D. (2020). "Top2Vec: Distributed Representations of Topics"
5. Blei, D., Ng, A., & Jordan, M. (2003). "Latent Dirichlet Allocation"
6. Sia, S., Dalmia, A., & Mielke, S. (2020). "Tired of Topic Models? Clusters of Pretrained Word Embeddings Make for Fast and Good Topics Too"
7. Grootendorst, M. (2023). "Dynamic Topic Modeling with BERTopic"
