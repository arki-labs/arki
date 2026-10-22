// Readers for the BEIR file shape (`corpus.jsonl`, `queries.jsonl`, `qrels/<split>.tsv`) and for
// RO-STS's `score<TAB>sentence1<TAB>sentence2` rows. Any folder in the BEIR shape works, which is how
// the eval reads `fleet/embeddings-eval/ro-retrieval-v1` without Arki depending on fleet.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const corpusRowSchema = z.object({ _id: z.string(), title: z.string().default(''), text: z.string() });

/** `domain` and `slices` are ro-retrieval-v1's additions: a slice tags a stress case (`names`, `numbers`, …). */
const queryRowSchema = z.object({
  _id: z.string(),
  text: z.string(),
  domain: z.string().optional(),
  slices: z.array(z.string()).default([]),
});

const qrelRowSchema = z.tuple([z.string(), z.string(), z.coerce.number().int().min(0)]);
const stsRowSchema = z.tuple([z.coerce.number().min(0).max(5), z.string(), z.string()]);

export type Passage = { readonly id: string; readonly text: string };
export type Query = {
  readonly id: string;
  readonly text: string;
  readonly domain?: string;
  readonly slices: readonly string[];
};
/** Query id → passage id → grade. A grade of 0 is judged not relevant. */
export type Qrels = ReadonlyMap<string, ReadonlyMap<string, number>>;
export type RetrievalSet = {
  readonly name: string;
  readonly corpus: readonly Passage[];
  /** Only queries with at least one relevant passage in the split, as BEIR evaluates them. */
  readonly queries: readonly Query[];
  readonly qrels: Qrels;
};
export type SimilarityPair = { readonly score: number; readonly a: string; readonly b: string };

async function lines(file: string): Promise<string[]> {
  const content = await readFile(file, 'utf8');
  // SciFact's qrels end lines with CRLF.
  return content.split(/\r?\n/).filter(line => line.trim() !== '');
}

export async function loadRetrievalSet(folder: string, split = 'test'): Promise<RetrievalSet> {
  const qrels = new Map<string, Map<string, number>>();
  const [header, ...rows] = await lines(path.join(folder, 'qrels', `${split}.tsv`));
  if (header !== 'query-id\tcorpus-id\tscore') throw new Error(`${folder}: unexpected qrels header ${header ?? ''}`);
  for (const row of rows) {
    const [query, passage, grade] = qrelRowSchema.parse(row.split('\t'));
    const judged = qrels.get(query) ?? new Map<string, number>();
    judged.set(passage, grade);
    qrels.set(query, judged);
  }

  const corpusLines = await lines(path.join(folder, 'corpus.jsonl'));
  const corpus = corpusLines.map(line => {
    const row = corpusRowSchema.parse(JSON.parse(line));
    // BEIR's convention: the title, a space, the text.
    return { id: row._id, text: row.title === '' ? row.text : `${row.title} ${row.text}` };
  });
  const queries: Query[] = [];
  for (const line of await lines(path.join(folder, 'queries.jsonl'))) {
    const row = queryRowSchema.parse(JSON.parse(line));
    const judged = qrels.get(row._id);
    if (judged === undefined || ![...judged.values()].some(grade => grade > 0)) continue;
    queries.push({
      id: row._id,
      text: row.text,
      slices: row.slices,
      ...(row.domain === undefined ? {} : { domain: row.domain }),
    });
  }
  return { name: path.basename(folder), corpus, queries, qrels };
}

export async function loadSimilarityPairs(file: string): Promise<SimilarityPair[]> {
  const rows = await lines(file);
  return rows.map(row => {
    const [score, a, b] = stsRowSchema.parse(row.split('\t'));
    return { score, a, b };
  });
}
