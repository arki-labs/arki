import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildErrorIndex,
  checkErrorDocs,
  errorDocsUrl,
  errorIndexSchema,
  missingErrorDocs,
  readErrorEntries,
} from './error-index';

const REGISTRY = `
export const DEMO_ERROR_CODES = {
  /**
   * A hook threw
   * twice.
   * @fix Catch it in the hook.
   * @verify bun run test
   */
  hookFailed: 'ARKI_DEMO_E001',
  /** No tags here. */
  bare: 'ARKI_DEMO_E002',
  notACode: 42,
} as const;
`;

const FAILURE = `
/**
 * The post is gone.
 * @fix Create it first.
 * @verify bun run test -- post
 */
export const PostNotFound = defineFailure('post.not_found', { status: 404 });
export const Undocumented = defineFailure('post.locked');
`;

describe('readErrorEntries', () => {
  it('reads thrown codes with the summary and both tags', () => {
    // Why: docs pages are built from this data; a lost tag means a page with no fix.
    const [first, second] = readErrorEntries(REGISTRY, 'src/e.ts', '@arki/demo');
    expect(first).toEqual({
      code: 'ARKI_DEMO_E001',
      package: '@arki/demo',
      kind: 'thrown',
      what: 'A hook threw twice.',
      fix: 'Catch it in the hook.',
      verify: 'bun run test',
      source: 'src/e.ts:9',
    });
    expect(second?.fix).toBeNull();
  });

  it('ignores registry properties that are not string codes', () => {
    // Why: a numeric or computed value is not a stable code, listing it would publish a wrong page.
    expect(readErrorEntries(REGISTRY, 'src/e.ts', 'p').map(entry => entry.code)).toEqual([
      'ARKI_DEMO_E001',
      'ARKI_DEMO_E002',
    ]);
  });

  it('reads defineFailure calls from the declaration JSDoc', () => {
    // Why: returned failures are half of the public error surface; they must be indexed like thrown codes.
    const entries = readErrorEntries(FAILURE, 'src/f.ts', 'p');
    expect(entries.map(entry => [entry.code, entry.kind, entry.what, entry.verify])).toEqual([
      ['post.not_found', 'failure', 'The post is gone.', 'bun run test -- post'],
      ['post.locked', 'failure', '', null],
    ]);
  });
});

describe('missingErrorDocs', () => {
  it('returns entries lacking @fix or @verify', () => {
    // Why: ERR_E001 fails the build on these, so an error nobody can act on does not ship.
    const entries = [...readErrorEntries(REGISTRY, 'a.ts', 'p'), ...readErrorEntries(FAILURE, 'b.ts', 'p')];
    expect(missingErrorDocs(entries).map(entry => entry.code)).toEqual(['ARKI_DEMO_E002', 'post.locked']);
  });
});

describe('buildErrorIndex', () => {
  it('scans src, skips tests, sorts by code and validates against the schema', () => {
    // Why: test fixtures must not leak fake codes into the published index.
    const dir = mkdtempSync(path.join(tmpdir(), 'error-index-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo' }));
    writeFileSync(path.join(dir, 'src', 'errors.ts'), `${FAILURE}${REGISTRY}`);
    writeFileSync(path.join(dir, 'src', 'errors.test.ts'), REGISTRY.replace('E001', 'E999'));
    const index = buildErrorIndex(dir);
    expect(errorIndexSchema.parse(index)).toHaveLength(4);
    expect(index.map(entry => entry.code)).toEqual([
      'ARKI_DEMO_E001',
      'ARKI_DEMO_E002',
      'post.locked',
      'post.not_found',
    ]);
  });
});

describe('checkErrorDocs', () => {
  it('reports one ERR_E001 per undocumented code, naming the missing tags and no line number', () => {
    // Why: library-check baselines findings by their text; a line number would unbaseline a code each time the file moves.
    const dir = mkdtempSync(path.join(tmpdir(), 'error-index-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo' }));
    writeFileSync(path.join(dir, 'src', 'errors.ts'), REGISTRY);
    expect(checkErrorDocs(dir)).toEqual([
      'ERR_E001 error code lacks @fix or @verify in its JSDoc: ARKI_DEMO_E002 (no @fix, @verify)',
    ]);
  });
});

describe('errorDocsUrl', () => {
  it('uses the code as it is', () => {
    // Why: links already printed in errors must keep working, so the scheme is stable.
    expect(errorDocsUrl('post.not_found')).toBe('https://arki.dev/errors/post.not_found');
  });
});
