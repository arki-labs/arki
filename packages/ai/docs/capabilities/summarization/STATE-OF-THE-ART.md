# State of the Art: Text Summarization (2024-2026)

## Overview

Text summarization has evolved from extractive sentence selection to abstractive neural generation, and now to LLM-powered multi-style summarization with citation grounding and quality verification. This document surveys techniques relevant to Avocabo's newsletter and content summarization pipeline.

## Historical Context

### Evolution Timeline

| Year | Milestone | Key Innovation |
|------|-----------|----------------|
| 1958 | Luhn's method | Frequency-based sentence extraction |
| 2004 | TextRank | Graph-based extractive summarization |
| 2015 | Rush et al. (ABS) | First neural abstractive summarizer |
| 2017 | Pointer-Generator | Copy mechanism for factual accuracy |
| 2018 | BERT-based extractive | Transformer encodings for sentence scoring |
| 2019 | BART / PEGASUS | Pre-trained seq2seq for abstractive summarization |
| 2020 | PRIMERA | Multi-document transformer summarization |
| 2022 | LLM summarization | GPT-3.5/Claude for zero-shot summarization |
| 2023 | Structured summarization | Zod-schema-constrained LLM outputs |
| 2024 | Citation-grounded summarization | Every claim linked to source passage |
| 2025 | Multi-style adaptive summarization | Same content, different styles per user preference |
| 2026 | Streaming incremental summaries | Update summaries as new related content arrives |

### Paradigm Shifts

```
Extractive (sentence selection, 1958-2017)
    ↓
Abstractive (seq2seq, BART/PEGASUS, 2017-2022)
    ↓
LLM Zero-Shot (GPT/Claude prompting, 2022-2024)
    ↓
Structured + Grounded (schema-constrained, cited, 2024+)
```

## Current State of Summarization

### Approach Comparison

| Approach | Fluency | Factuality | Cost | Speed | Customization |
|----------|---------|-----------|------|-------|---------------|
| Extractive (TextRank) | Low | Perfect (verbatim) | Free | <100ms | None |
| BART / PEGASUS | Good | Good | Free (self-hosted) | ~500ms | Fine-tunable |
| LLM zero-shot | Excellent | Good-Very Good | ~$0.005/doc | ~2s | Prompt-tunable |
| LLM structured output | Excellent | Very Good | ~$0.008/doc | ~3s | Schema-defined |
| LLM + citation grounding | Excellent | Excellent | ~$0.015/doc | ~5s | Schema + verified |

### Model Quality for Summarization (Feb 2026)

| Model | ROUGE-L | Factual Consistency | Conciseness | Cost (1K summaries) |
|-------|---------|-------------------|-------------|---------------------|
| Claude Opus 4.6 | Best | Best | Very Good | ~$15 |
| Sonnet 4.5 | Very Good | Very Good | Good | ~$3 |
| Haiku 4.5 | Good | Good | Very Good | ~$0.80 |
| GPT-5.1 | Very Good | Very Good | Good | ~$10 |
| GPT-5.1 Mini | Good | Good | Good | ~$2.50 |
| Gemini 2.5 Flash | Good | Moderate | Good | ~$1.50 |

## Architecture Patterns

### Single-Document Summarization (Newsletter Ingestion)

```
Newsletter arrives
  → Clean HTML / extract content
  → Classify content type (Lane 1): news, analysis, tutorial, opinion
  → Summarize (Lane 1 for standard, Lane 2 for complex):
      Input: content + schema + style guide
      Output: { title, summary, keyPoints[], entities[], sentiment, readingTime }
  → Verify (optional, sampled): LLM-as-judge for factuality
  → Store summary + link to source
```

### Multi-Document Summarization (Digest Synthesis)

```
Multiple items in same cluster/topic
  → Retrieve all items (or top-N by relevance)
  → Strategy selection:
      ≤5 items: stuff all into context
      6-20 items: map-reduce (summarize each → synthesize summaries)
      >20 items: hierarchical (chunk → summarize → cluster → synthesize)
  → Synthesize (Lane 2):
      Input: item summaries + synthesis instructions + style guide
      Output: { sectionTitle, narrative, highlights[], sources[] }
  → Citation verification: each claim → source passage match
```

### Incremental Summarization (Streaming Updates)

```
Existing synthesis: "AI safety focused on alignment and interpretability this week"
New item arrives: "EU proposes mandatory AI safety testing for frontier models"

Update strategy:
  Option A: Regenerate full synthesis (expensive, ~$0.01)
  Option B: Delta update — "Also: EU now proposes mandatory testing" (cheap, ~$0.003)
  Option C: Flag as "updated" — regenerate on next digest cycle (cheapest, $0)
```

## Key Techniques

### Prompt Engineering for Summarization

| Technique | Description | Impact |
|-----------|-------------|--------|
| Style instructions | "Write in Avocabo's voice: concise, no clickbait" | Consistent brand voice |
| Schema constraint | Zod schema forces structured output (title, keyPoints, etc.) | Reliable parsing |
| Length control | "Maximum 150 words" or token limit | Prevents verbose outputs |
| Audience awareness | "For a busy professional, not a specialist" | Appropriate detail level |
| Key point extraction | "Identify 3-5 key takeaways" | Scannable output |
| Negative examples | "Do NOT include filler like 'In conclusion...'" | Reduces generic language |

### Factual Consistency Verification

| Method | Accuracy | Cost | Speed |
|--------|----------|------|-------|
| NLI-based (SummaC) | Good | Free (self-hosted) | Fast |
| LLM-as-judge | Very Good | ~$0.002/check | ~2s |
| Source passage matching | Good | ~$0.001/check (embedding) | ~1s |
| Human evaluation | Best | Expensive | Slow |

### Citation Grounding Pipeline

```
Summary: "Revenue grew 25% [1], driven by cloud services [1,2]."

Verification:
  For each [citation]:
    → Extract claim text
    → Find cited source passage
    → Embedding similarity: is the claim close to the passage?
    → If similarity < 0.75: flag for LLM review
    → LLM-as-judge: "Does passage support claim?"
    → Mark: verified / unverified / hallucinated
```

## Advanced Techniques (2025-2026)

### Adaptive Summarization Styles

Same content summarized differently based on user preferences:

| Style | Length | Tone | Focus | Use Case |
|-------|--------|------|-------|----------|
| Executive | 2-3 sentences | Formal, decisive | Decisions, actions | Busy executives |
| Analytical | 1-2 paragraphs | Neutral, thorough | Data, evidence | Researchers |
| Casual | 3-5 bullets | Conversational | Headlines, trends | Quick scan |
| Deep dive | Full page | Educational | Context, nuance | Weekend reading |

**Implementation:** Style parameter in `@arki/ai` StructuredGenerator call. User selects default style in settings.

### Progressive Summarization (Layered Detail)

Inspired by Tiago Forte's "progressive summarization" concept:

```
Layer 1: Title + 1-sentence summary (always shown)
Layer 2: Key points (3-5 bullets, shown in digest)
Layer 3: Detailed summary (2-3 paragraphs, expandable)
Layer 4: Full original content (linked)
```

Each layer is generated independently, with decreasing compression ratio.

### Anti-Guilt Summarization

Unique to Avocabo's philosophy: summaries should make users feel informed, not guilty about unread content.

```
Traditional: "You have 47 unread newsletters"
Anti-guilt: "Here's what mattered this week — you're caught up in 3 minutes"
```

This requires:
- Relevance filtering before summarization (skip low-relevance items)
- Positive framing in synthesis ("You're up to date" vs. "You missed")
- Completeness confidence ("This covers 90% of key developments")

### Hallucination-Resistant Summarization

Techniques to minimize factual errors in generated summaries:

| Technique | Description | Overhead |
|-----------|-------------|----------|
| Source-constrained decoding | Only generate tokens that appear in or are entailed by source | Higher latency |
| Citation-first generation | Generate citations inline, then fill narrative around them | Modest |
| Post-generation verification | LLM-as-judge checks each claim against source | +$0.002/summary |
| Confidence scoring | Assign confidence to each claim based on source support | Modest |

## Evaluation Metrics

### Automatic Metrics

| Metric | Measures | Limitations |
|--------|---------|-------------|
| ROUGE-L | Overlap with reference | Doesn't capture semantics |
| BERTScore | Semantic similarity to reference | Requires reference summaries |
| FactCC | Factual consistency | Binary, misses nuance |
| SummaC | NLI-based consistency | Good but not perfect |

### LLM-as-Judge Metrics (Preferred for Production)

| Metric | Question to Judge | Scale |
|--------|-------------------|-------|
| Factuality | "Are all claims in the summary supported by the source?" | 0-1 |
| Completeness | "Does the summary cover the key points?" | 0-1 |
| Conciseness | "Is the summary free of redundancy and filler?" | 0-1 |
| Readability | "Is the summary clear and well-organized?" | 0-1 |
| Tone match | "Does the summary match the specified style?" | 0-1 |

### User Metrics

| Metric | Description |
|--------|-------------|
| Click-through rate | % summaries that lead to reading the full article |
| Time-to-archive | How quickly users archive/dismiss after reading summary |
| Digest completion rate | % of digest consumed before closing |
| Feedback signals | Thumbs up/down, "too long", "missed key point" |

## Challenges and Limitations

1. **Faithfulness vs. fluency trade-off:** More fluent summaries tend to hallucinate more. Structured output with citations mitigates this.
2. **Newsletter-specific challenges:** Newsletters mix reporting, opinion, and promotion. Separating signal from marketing is hard.
3. **Multi-language summarization:** Quality degrades significantly for non-English content with English-trained models.
4. **Attribution in synthesis:** When synthesizing 10+ sources, correctly attributing each claim to its origin is error-prone.
5. **Compression ratio selection:** Too compressed → loses nuance. Too verbose → defeats the purpose.
6. **Style drift:** Over time, LLM summarization style may shift subtly with model updates. Continuous eval required.

## Best Practices for Avocabo

1. **Use Lane 1 (Haiku 4.5) for standard summaries** — good enough for 80% of newsletters at 1/20th the cost of Lane 3.
2. **Structured output always** — Zod schemas ensure reliable parsing and consistent format.
3. **Citation grounding for synthesis** — every claim in digest synthesis must cite its source.
4. **Progressive detail** — generate all 4 layers (title → bullets → paragraph → link).
5. **Evaluate with LLM-as-judge** — ROUGE is insufficient for LLM-generated summaries. Use factuality + completeness scoring.
6. **Anti-guilt framing** — summarization UX should reduce anxiety, not increase it.

## References

1. Rush, A., Chopra, S., & Weston, J. (2015). "A Neural Attention Model for Abstractive Sentence Summarization"
2. See, A., Liu, P., & Manning, C. (2017). "Get To The Point: Summarization with Pointer-Generator Networks"
3. Lewis, M., et al. (2020). "BART: Denoising Sequence-to-Sequence Pre-training for Natural Language Generation"
4. Zhang, J., et al. (2020). "PEGASUS: Pre-training with Extracted Gap-sentences for Abstractive Summarization"
5. Xiao, W., et al. (2022). "PRIMERA: Pyramid-based Masked Sentence Pre-training for Multi-document Summarization"
6. Laban, P., et al. (2022). "SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization"
7. Goyal, T., et al. (2023). "News Summarization and Evaluation in the Era of GPT-3"
8. Forte, T. (2017). "Progressive Summarization: A Practical Technique for Designing Discoverable Notes"
