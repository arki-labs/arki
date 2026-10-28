import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildErrorIndex,
  checkErrorDocs,
  duplicateErrorCodes,
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
      'ERR_E001 error code lacks summary, @fix or @verify in its JSDoc: ARKI_DEMO_E002 (no @fix, @verify)',
    ]);
  });
});

describe('errorDocsUrl', () => {
  it('uses the code as it is', () => {
    // Why: links already printed in errors must keep working, so the scheme is stable.
    expect(errorDocsUrl('post.not_found')).toBe('https://arki.dev/errors/post.not_found');
  });
});

describe('canonical definitions', () => {
  it('indexes literal namespace members and destructured aliases without trusting shadowed objects', () => {
    // Why: alternate JavaScript access syntax must not bypass docs or duplicate-code checks.
    const entries = readErrorEntries(
      `import * as failures from '@arki/failure';
      const { defineFailure: make } = failures;
      const One = make('post.one');
      const Two = failures['defineFailure']('post.two');
      const namespace = failures;
      const { ['defineFailure']: another } = namespace;
      const Three = another('post.three');
      const defineFailure = 'isFailure';
      const { [defineFailure]: isFailure } = failures;
      const NotDefinition = isFailure('not.a.definition');
      function shadowed(failures: { defineFailure: (code: string) => string }) {
        const { defineFailure: unrelated } = failures;
        const NotFailure = unrelated('not.failure');
        const AlsoNotFailure = failures['defineFailure']('also.not.failure');
      }`,
      'src/errors.ts',
      'p',
    );
    expect(entries.map(entry => entry.code)).toEqual(['post.one', 'post.two', 'post.three']);
  });

  it('refuses mutable destructured factory aliases instead of silently losing coverage', () => {
    expect(() =>
      readErrorEntries(
        `import * as failures from '@arki/failure';
        let { defineFailure: make } = failures;
        const Missing = make('post.missing');`,
        'src/errors.ts',
        'p',
      ),
    ).toThrow('ERR_E003');
  });

  it('reads aliases of canonical factory imports', () => {
    // Why: renaming an import must not silently remove a failure from public docs.
    const entries = readErrorEntries(
      `
      import { defineFailure as failure } from '@arki/failure';
      import * as failures from '@arki/failure';
      const Missing = failure('post.missing');
      const Locked = failures.defineFailure('post.locked');
      const unrelated = other.defineFailure('not.a_failure');
    `,
      'src/errors.ts',
      'p',
    );
    expect(entries.map(entry => entry.code)).toEqual(['post.missing', 'post.locked']);
  });

  it('reads original declarations without executing initialization or repeating re-exports', () => {
    // Why: several barrels expose one definition and its module can have side effects.
    const dir = mkdtempSync(path.join(tmpdir(), 'error-index-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo' }));
    writeFileSync(path.join(dir, 'src', 'failures.ts'), `throw new Error('must never run');\n${FAILURE}`);
    writeFileSync(path.join(dir, 'src', 'index.ts'), "export { PostNotFound } from './failures';");
    writeFileSync(path.join(dir, 'src', 'alias.ts'), "export { PostNotFound as Missing } from './failures';");
    const index = buildErrorIndex(dir);
    expect(index).toHaveLength(2);
    expect(index.every(entry => entry.source.startsWith('src/failures.ts:'))).toBe(true);
    expect(duplicateErrorCodes(index)).toEqual([]);
  });

  it('reports one duplicate finding for colliding definitions even across error kinds', () => {
    // Why: one public error URL cannot describe two different definitions, even with fixes.
    const dir = mkdtempSync(path.join(tmpdir(), 'error-index-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo' }));
    const doc = '/** Missing post. \n * @fix Create the post. \n * @verify bun run test \n */';
    writeFileSync(path.join(dir, 'src', 'failure.ts'), `${doc}\nexport const Missing = defineFailure('post.missing');`);
    writeFileSync(
      path.join(dir, 'src', 'registry.ts'),
      `export const DEMO_ERROR_CODES = {\n${doc}\nmissing: 'post.missing' };`,
    );
    writeFileSync(path.join(dir, 'src', 'other.ts'), `${doc}\nexport const Other = defineFailure('post.missing');`);
    expect(buildErrorIndex(dir)).toHaveLength(3);
    expect(checkErrorDocs(dir)).toEqual(['ERR_E002 error code has multiple definitions: post.missing']);
  });
});

describe('documentation completeness and static privacy', () => {
  it('requires a nonempty summary and both nonempty remediation tags', () => {
    const entries = readErrorEntries(
      `
      /**
       * @fix Recreate the post.
       * @verify bun run test
       */
      const MissingSummary = defineFailure('post.no_summary');
      /** A post is missing.
       * @fix
       * @verify
       */
      const EmptyTags = defineFailure('post.empty_tags');
    `,
      'src/errors.ts',
      'p',
    );
    expect(missingErrorDocs(entries).map(entry => entry.code)).toEqual(['post.no_summary', 'post.empty_tags']);
  });

  it('resolves chained local constant aliases and respects lexical shadowing', () => {
    const entries = readErrorEntries(
      `
      import { defineFailure as failure } from '@arki/failure';
      import * as failures from '@arki/failure';
      const make = failure;
      const chained = (make);
      const fromNamespace = failures.defineFailure;
      const One = chained('post.one');
      const Two = fromNamespace('post.two');
      function nested() {
        const local = make;
        const Three = local('post.three');
      }
      function unrelated(make: (code: string) => string) {
        const NotFailure = make('not.a_failure');
      }
      function shadowed(failures: { defineFailure: (code: string) => string }) {
        const NotFailure = failures.defineFailure('also.not_a_failure');
      }
    `,
      'src/errors.ts',
      'p',
    );
    expect(entries.map(entry => entry.code)).toEqual(['post.one', 'post.two', 'post.three']);
  });

  it('indexes the factory package own local imports without accepting unrelated imports', () => {
    const source = `import { defineFailure } from './failure.js';
      const make = defineFailure;
      const Invalid = make('schema.invalid_input');`;
    expect(readErrorEntries(source, 'src/foundations.ts', '@arki/failure').map(entry => entry.code)).toEqual([
      'schema.invalid_input',
    ]);
    expect(readErrorEntries(source, 'src/errors.ts', '@arki/unrelated')).toEqual([]);
  });

  it('fails explicitly when a known factory code cannot be indexed statically', () => {
    expect(() =>
      readErrorEntries(
        `
      import { defineFailure } from '@arki/failure';
      const make = defineFailure;
      const Missing = make(getCode());
    `,
        'src/errors.ts',
        'p',
      ),
    ).toThrow(/ERR_E003.*src\/errors.ts/);
  });

  it('rejects mutable factory aliases rather than trusting a stale initializer', () => {
    expect(() =>
      readErrorEntries(
        `
      import { defineFailure } from '@arki/failure';
      let make = defineFailure;
      const Missing = make('post.missing');
    `,
        'src/errors.ts',
        'p',
      ),
    ).toThrow(/ERR_E003/);
  });

  it('never evaluates a module or includes private factory payloads in JSON', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'error-index-'));
    mkdirSync(path.join(dir, 'src'));
    const marker = path.join(dir, 'executed');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/demo' }));
    writeFileSync(
      path.join(dir, 'src', 'errors.ts'),
      `
      import { writeFileSync } from 'node:fs';
      import { defineFailure } from '@arki/failure';
      writeFileSync(${JSON.stringify(marker)}, 'ran');
      /** The post is missing.
       * @fix Create the post.
       * @verify bun run test
       */
      export const Missing = defineFailure('post.missing', {
        message: 'PRIVATE_MESSAGE',
        cause: new Error('PRIVATE_CAUSE'),
        data: { token: 'PRIVATE_TOKEN', payload: 'PRIVATE_PAYLOAD' },
        get remediation() { throw new Error('must never evaluate'); }
      });
    `,
    );
    const index = errorIndexSchema.parse(buildErrorIndex(dir));
    expect(index).toHaveLength(1);
    expect(Object.keys(index[0] ?? {}).toSorted()).toEqual([
      'code',
      'fix',
      'kind',
      'package',
      'source',
      'verify',
      'what',
    ]);
    expect(JSON.stringify(index)).not.toMatch(/PRIVATE_|cause|payload|token|message/);
    expect(existsSync(marker)).toBe(false);
  });
});
