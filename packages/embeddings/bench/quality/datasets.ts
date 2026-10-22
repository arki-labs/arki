// The quality eval's public datasets, pinned by revision and sha256, downloaded once into
// `.cache/datasets/` (gitignored). Run: `bun bench/quality/datasets.ts`; the eval calls it too.
//
// SciFact and NFCorpus are BEIR's two smallest retrieval sets, from MTEB's copies on Hugging Face,
// whole corpora with the test qrels. RO-STS (sentence pairs scored 0-5) is a Romanian similarity
// diagnostic, not retrieval. The Romanian retrieval set lives in `fleet/embeddings-eval`.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DATASET_DIR = path.join(import.meta.dirname, '..', '..', '.cache', 'datasets');

type RemoteFile = { readonly file: string; readonly url: string; readonly sha256: string };

/** Commit of each source, read on 2026-10-21. */
const SCIFACT = 'https://huggingface.co/datasets/mteb/scifact/resolve/cf10ab6856b15b0e670ef8ae5dae4e266c12d035';
const NFCORPUS = 'https://huggingface.co/datasets/mteb/nfcorpus/resolve/52ac3f19d3449632d9f00aab0ad34a110fc03816';
const RO_STS =
  'https://raw.githubusercontent.com/dumitrescustefan/RO-STS/98b5804b454892c70815777fe03e874ea7f20f1b/dataset/text-similarity';

export const DATASETS = {
  scifact: [
    {
      file: 'corpus.jsonl',
      url: `${SCIFACT}/corpus.jsonl`,
      sha256: 'f0d32db0d156b526d75921ed7a76f2cb912902631c87248c5c97c617bad0b60c',
    },
    {
      file: 'queries.jsonl',
      url: `${SCIFACT}/queries.jsonl`,
      sha256: '9db7df096f7414435d52bafcbacf814c30cea50eb565c1e8fa6d11440759bba8',
    },
    {
      file: 'qrels/test.tsv',
      url: `${SCIFACT}/qrels/test.tsv`,
      sha256: '0864bb985e0ca2367ba217977e72004d549054b2b06666ed9d4825ac7c21284c',
    },
  ],
  nfcorpus: [
    {
      file: 'corpus.jsonl',
      url: `${NFCORPUS}/corpus.jsonl`,
      sha256: 'ee3db77bc2183e66b9c114e6eca4adf44de381705b1f8c94de8efdd232f0c4ff',
    },
    {
      file: 'queries.jsonl',
      url: `${NFCORPUS}/queries.jsonl`,
      sha256: '1b893f53f3f62e8f2949a6db619a9cb058e8d97901a5010e108e60c4ef5fd924',
    },
    {
      file: 'qrels/test.tsv',
      url: `${NFCORPUS}/qrels/test.tsv`,
      sha256: 'f8fba6ef3d4dd9c3a242a8ba4ae38276fc3622fce7dcbae764766d564542fd2a',
    },
  ],
  'ro-sts': [
    {
      file: 'test.tsv',
      url: `${RO_STS}/RO-STS.test.tsv`,
      sha256: 'fd84bc1f9581e6352f0c797cb46fdf08a39f7b908a6ff1cfe21deb62f8c78e0c',
    },
  ],
} as const satisfies Record<string, readonly RemoteFile[]>;

export type DatasetName = keyof typeof DATASETS;

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function readIfValid(target: string, expected: string): Promise<boolean> {
  try {
    return sha256(await readFile(target)) === expected;
  } catch {
    return false;
  }
}

async function ensureFiles(name: string, files: readonly RemoteFile[]): Promise<string> {
  const folder = path.join(DATASET_DIR, name);
  for (const { file, url, sha256: expected } of files) {
    const target = path.join(folder, file);
    if (await readIfValid(target, expected)) continue;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${name}/${file}: HTTP ${response.status} from ${url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actual = sha256(bytes);
    // A moved upstream file must never change the numbers silently.
    if (actual !== expected) throw new Error(`${name}/${file}: sha256 ${actual}, pinned ${expected}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(`${target}.part`, bytes);
    await rename(`${target}.part`, target);
  }
  return folder;
}

/** The dataset's folder, after every file is present with its pinned checksum. Throws on a mismatch. */
export const ensureDataset = (name: DatasetName): Promise<string> => ensureFiles(name, DATASETS[name]);

if (import.meta.main) {
  for (const [name, files] of Object.entries(DATASETS)) {
    process.stdout.write(`${name}: ${await ensureFiles(name, files)}\n`);
  }
}
