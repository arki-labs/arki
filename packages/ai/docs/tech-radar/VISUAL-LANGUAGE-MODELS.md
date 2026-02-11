# Visual Language Models — Technology Annex

> **Last verified:** February 2026
> **Parent:** [AI Tech Radar (Wow Factor Edition)](./AI-TECH-RADAR-WOW-FACTOR-2026.md)

---

## 1. The Paradigm Shift: VLMs Replace OCR Pipelines

Traditional document processing: `PDF → OCR engine → raw text → LLM → structured output`

Modern VLM approach: `PDF → VLM → structured output (directly)`

End-to-end VLMs understand layout, tables, charts, and figures natively — no separate OCR step. This eliminates the lossy text extraction phase and preserves spatial relationships (e.g., "the bar chart shows Q4 revenue at $2.3B" instead of extracting just the number "2.3").

**Impact for Avocabo:** Newsletter PDFs, research reports, and slide decks become first-class content sources. The "Explain this chart to me" product concept becomes technically straightforward.

---

## 2. Frontier VLMs (General Purpose)

| Model | Provider | Context | Strengths | Cost (1M input) | Best For |
|-------|----------|---------|-----------|-----------------|----------|
| **Gemini 2.5 Pro** | Google | 2M tokens | Best video+doc understanding, largest context | ~$2.50 | Full-document analysis, video |
| **Claude Opus 4.6** | Anthropic | 1M tokens | Best instruction-following with images, accurate OCR | ~$15.00 | Complex chart interpretation |
| **GPT-5.1** | OpenAI | 256K tokens | Strong general vision, well-tested | ~$10.00 | General image understanding |
| **Qwen3-VL-235B** | Alibaba | 128K tokens | Best open-source VLM, competitive with frontier | Free (self-hosted) | Privacy-sensitive processing |
| **Llama 4 Maverick** | Meta | 1M tokens | Open-weights, multimodal native | Free (self-hosted) | Batch processing at scale |

**Recommendation:** Gemini 2.5 Pro as primary VLM for document understanding (best quality/cost for visual docs). Claude Opus 4.6 for complex chart interpretation requiring careful reasoning. Qwen3-VL as self-hosted fallback for cost optimization at scale.

---

## 3. Specialized OCR + Semantic Models

These models are purpose-built for document OCR with semantic understanding — smaller, faster, and cheaper than frontier VLMs for pure document extraction.

| Model | Provider | Params | Cost | Languages | Key Feature |
|-------|----------|--------|------|-----------|-------------|
| **Mistral OCR** | Mistral | API | $0.001/page | 50+ | LaTeX output, chart/table extraction, structured JSON |
| **DeepSeek-OCR 3B** | DeepSeek | 3B | **Free** (open) | 100+ | Best free OCR, handles complex layouts |
| **GLM-OCR 0.9B** | THUDM | 0.9B | **Free** (open) | 20+ | Mobile-friendly, runs on phones |
| **MiniCPM-V 8B** | OpenBMB | 8B | **Free** (open) | 30+ | Runs on consumer GPUs, good charts |
| **Docling** | IBM | Pipeline | **Free** (open) | Multi | Full document conversion pipeline |

### Mistral OCR Deep Dive

Mistral OCR is the standout for Avocabo's needs:

- **Structured JSON output**: Tables extracted as JSON arrays, not flattened text
- **LaTeX preservation**: Mathematical formulas rendered correctly (relevant for research newsletters)
- **Chart understanding**: Bar charts, line charts, pie charts described with data points
- **Layout awareness**: Multi-column layouts, sidebars, footnotes properly segmented
- **API integration**: Simple REST API, fits cleanly into `@arki/ai` ProviderRouter Lane 4

Example output for a chart:
```json
{
  "type": "chart",
  "chartType": "bar",
  "title": "Q4 2025 Revenue by Segment",
  "data": [
    { "segment": "Cloud", "value": 2300, "unit": "M USD" },
    { "segment": "Devices", "value": 1100, "unit": "M USD" }
  ],
  "insight": "Cloud segment grew 25% YoY, now 68% of total revenue"
}
```

---

## 4. Video Understanding

Relevant for YouTube transcript enrichment and video newsletter content.

| Model | Provider | Capability | Cost | Duration Limit |
|-------|----------|-----------|------|----------------|
| **Gemini 2.5 Pro** | Google | Full video analysis (audio + visual + text) | ~$2.50/1M tokens | Up to 2 hours |
| **GPT-5.1** | OpenAI | Frame-by-frame analysis | Higher | Limited |
| **Qwen3-VL-235B** | Alibaba | Video understanding (open-source) | Free (self-hosted) | ~30 min |

**Recommendation:** Gemini 2.5 Pro for video understanding. Its 2M context window can ingest entire video transcripts + keyframes, and it natively processes audio tracks. This powers enriched YouTube content ingestion beyond just transcript text.

---

## 5. Recommended Stack for Avocabo

### Document Processing Pipeline

```
Incoming content (PDF, image, slide)
  → Format detection
  → Route by complexity:

  Simple text PDF → Mistral OCR (fast, cheap, $0.001/page)
    → Structured text + metadata

  Complex PDF (charts, tables, mixed layout) → Mistral OCR + VLM enrichment
    → Mistral OCR: extract text and structure
    → Gemini 2.5 Pro: interpret charts, describe figures
    → Merge: structured text + visual insights

  Image/screenshot → Gemini 2.5 Pro (direct VLM)
    → Description + extracted text + data points

  Video → Gemini 2.5 Pro (native multimodal)
    → Transcript + visual summary + key moments
```

### Integration as ProviderRouter Lane 4

Lane 4 in `@arki/ai` ProviderRouter handles all specialist models. Visual processing adds:

```
Lane 4 sub-routes:
  vision.ocr      → Mistral OCR (primary) | DeepSeek-OCR 3B (fallback, free)
  vision.interpret → Gemini 2.5 Pro (primary) | Claude Opus 4.6 (complex reasoning)
  vision.video     → Gemini 2.5 Pro (only viable option at this context window)
```

### Cost Estimates

| Content Type | Volume (per user/month) | Cost per Item | Monthly per User |
|-------------|----------------------|---------------|-----------------|
| PDF newsletters | ~20 | $0.001 (Mistral OCR) | $0.02 |
| Charts/figures | ~10 | $0.005 (Gemini VLM) | $0.05 |
| Screenshots | ~5 | $0.003 (Gemini VLM) | $0.015 |
| YouTube videos | ~4 | $0.02 (Gemini video) | $0.08 |
| **Total** | | | **~$0.17/user/month** |

Visual processing is remarkably cheap — the wow factor of "understanding charts" costs less than a single LLM summarization call.

---

## 6. Visual Insight Cards — Product Integration

The "Explain this chart to me" product concept (hub Section 3.3) uses this stack:

1. **Ingestion:** Newsletter PDF arrives → Mistral OCR extracts text + identifies visual elements
2. **Enrichment:** Charts/figures sent to Gemini 2.5 Pro for interpretation
3. **Card generation:** `@arki/ai` StructuredGenerator (Lane 2) creates visual insight card:
   ```
   { title, chartDescription, keyTakeaways[], relatedContent[], implications }
   ```
4. **Display:** Rendered in digest alongside text summary, expandable for full interpretation
5. **Cross-reference:** VectorSearchProvider links visual insights to related content in user's library

**Wow moment:** User sees "Chart: AI infrastructure spend grew 340% in 2025" with a plain-English interpretation, linked to 3 related newsletters they've read about cloud costs.

---

## Sources

- Mistral OCR: <https://docs.mistral.ai/capabilities/document_ai>
- Gemini vision: <https://ai.google.dev/gemini-api/docs/document-processing>
- Anthropic PDF support: <https://docs.anthropic.com/en/docs/build-with-claude/pdf-support>
- Qwen3-VL: <https://huggingface.co/Qwen/Qwen3-VL-235B>
- DeepSeek-OCR: <https://github.com/deepseek-ai/DeepSeek-VL>
- Docling: <https://github.com/DS4SD/docling>
- MiniCPM-V: <https://github.com/OpenBMB/MiniCPM-V>
