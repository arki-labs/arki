/**
 * The site lives in the private workspace repo and reads its types from the
 * copy `site` writes. These tests prove the copy can stand alone there (zod is
 * its only import, and it compiles with nothing else installed) and that it
 * says exactly what the source schemas say, so the site and the release tool
 * can never disagree about a data file.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { renderSiteSchemaCopy, SITE_SCHEMA_SOURCES } from './site-schema-copy';

const PACKAGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** This package's compiler options (strict, `noUnusedLocals`, `verbatimModuleSyntax`, ...), with no ambient types. */
function compilerOptions(): ts.CompilerOptions {
  const file = path.join(PACKAGE_DIR, 'tsconfig.json');
  const config = ts.readConfigFile(file, ts.sys.readFile.bind(ts.sys));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE_DIR, undefined, file);
  return { ...parsed.options, types: [] };
}

/** Type errors of `rootFile` and everything it imports, formatted; empty when it compiles. */
function typeErrors(rootFile: string): string {
  const program = ts.createProgram([rootFile], compilerOptions());
  const diagnostics = ts.getPreEmitDiagnostics(program);
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => path.dirname(rootFile),
    getNewLine: () => '\n',
  });
}

type ExportedNames = {
  readonly values: readonly string[];
  readonly types: readonly string[];
};

/** The names a module exports, read from its syntax. */
function exportedNames(fileName: string, text: string): ExportedNames {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of source.statements) {
    const exported =
      ts.canHaveModifiers(statement) &&
      (ts.getModifiers(statement) ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) values.push(declaration.name.text);
    } else if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) {
      types.push(statement.name.text);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) {
      values.push(statement.name.text);
    }
  }
  return { values, types };
}

function importSpecifiers(text: string): string[] {
  const source = ts.createSourceFile('copy.ts', text, ts.ScriptTarget.Latest, true);
  return source.statements.flatMap(statement =>
    ts.isImportDeclaration(statement)
      ? [ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : '?']
      : [],
  );
}

function sourceNames(): ExportedNames[] {
  return SITE_SCHEMA_SOURCES.map(file => exportedNames(file, ts.sys.readFile(file) ?? ''));
}

describe('site schema copy', () => {
  it('imports zod and nothing else, so the site needs none of this repo to read it', () => {
    expect(importSpecifiers(renderSiteSchemaCopy())).toEqual(['zod']);
  });

  it('exports every name its source modules export, and only those', () => {
    const copy = exportedNames('copy.ts', renderSiteSchemaCopy());
    const sources = sourceNames();
    expect(copy.values.toSorted()).toEqual(sources.flatMap(s => s.values).toSorted());
    expect(copy.types.toSorted()).toEqual(sources.flatMap(s => s.types).toSorted());
  });

  it('typechecks on its own, in a folder that has only zod installed', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arki-site-schema-copy-'));
    try {
      const zodDir = path.dirname(createRequire(import.meta.url).resolve('zod/package.json'));
      mkdirSync(path.join(dir, 'node_modules'));
      symlinkSync(zodDir, path.join(dir, 'node_modules', 'zod'), 'dir');
      const file = path.join(dir, 'site-schema.ts');
      writeFileSync(file, renderSiteSchemaCopy());
      expect(typeErrors(file)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('has exactly the types of its sources: every schema output, value and type, both ways', () => {
    mkdirSync(path.join(PACKAGE_DIR, '.cache'), { recursive: true });
    const dir = mkdtempSync(path.join(PACKAGE_DIR, '.cache', 'site-schema-copy-'));
    try {
      writeFileSync(path.join(dir, 'site-schema.ts'), renderSiteSchemaCopy());
      const sources = sourceNames();
      const lines = [
        "import { expectTypeOf } from 'vitest';",
        "import type { z } from 'zod';",
        "import type * as Copy from './site-schema';",
        ...SITE_SCHEMA_SOURCES.map(
          (file, i) => `import type * as Source${String(i)} from '${path.relative(dir, file).replace(/\.ts$/, '')}';`,
        ),
        `expectTypeOf<keyof typeof Copy>().toEqualTypeOf<${sources.map((_, i) => `keyof typeof Source${String(i)}`).join(' | ')}>();`,
      ];
      let schemas = 0;
      for (const [i, { values, types }] of sources.entries()) {
        const from = `Source${String(i)}`;
        for (const name of values) {
          lines.push(`expectTypeOf<typeof Copy.${name}>().toEqualTypeOf<typeof ${from}.${name}>();`);
          if (name.endsWith('Schema')) {
            schemas += 1;
            lines.push(`expectTypeOf<z.output<typeof Copy.${name}>>().toEqualTypeOf<z.output<typeof ${from}.${name}>>();`);
          }
        }
        for (const name of types) lines.push(`expectTypeOf<Copy.${name}>().toEqualTypeOf<${from}.${name}>();`);
      }
      expect(schemas).toBeGreaterThan(10);
      const check = path.join(dir, 'check.ts');
      writeFileSync(check, `${lines.join('\n')}\n`);
      expect(typeErrors(check)).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('refuses a source that imports a module the copy does not hold', () => {
    // site-schema.ts alone: its error and examples schemas would be missing from the copy.
    const siteSchema = SITE_SCHEMA_SOURCES.at(-1) ?? '';
    expect(() => renderSiteSchemaCopy([siteSchema])).toThrow(/not an earlier module in SITE_SCHEMA_SOURCES/);
  });
});
