/**
 * The public operations of the package, derived at test time
 *
 * Imports every module the `package.json` `exports` map names, and lists
 * every exported function and every public method of every exported class.
 * A new export or method shows up here by itself, so it fails the gate's
 * completeness check until it has a case or a listed exemption.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import { srcDir } from './engine.js';

const packageJsonSchema = z.object({
  exports: z.record(z.string(), z.union([z.string(), z.object({ import: z.string() })])),
});

/** `./dist/core/money.js` → `core/money.ts`. */
function sourceOf(target: string): string {
  return target.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts');
}

function isClass(value: unknown): value is abstract new (...args: never[]) => unknown {
  return typeof value === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(value));
}

/** A failure definition from `defineFailure`: a frozen maker with a `code` and an `is` guard. */
function isFailureDefinition(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'is' in value &&
    typeof value.is === 'function'
  );
}

function declares(text: string, name: string): boolean {
  return new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|const|let|class)\\s+${name}\\b`,
  ).test(text);
}

/** The body of `class Name` in a source text: from its declaration to the next top-level declaration. */
function classBody(text: string, name: string): string {
  const start = text.search(new RegExp(`class\\s+${name}\\b`));
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const end = rest.search(/\n(?:export\s|class\s|function\s|const\s)/);
  return end < 0 ? rest : rest.slice(0, end);
}

function isHidden(body: string, method: string): boolean {
  return new RegExp(`\\b(?:private|protected)\\s+(?:static\\s+)?(?:async\\s+)?${method}\\s*[(<]`).test(body);
}

/** Why an operation needs no case: the structural kinds every package has. */
export type StructuralExemption = 'failure definition' | 'error class' | 'abstract class';

export type Inventory = {
  /** `<path under src>::<name>` for functions and constructors, `::<Class>.<method>` for methods. */
  operations: string[];
  /** Callables that are not operations, with the structural reason. */
  structural: Map<string, StructuralExemption>;
};

export async function inventory(): Promise<Inventory> {
  const pkg = packageJsonSchema.parse(JSON.parse(readFileSync(`${srcDir}../package.json`, 'utf8')));
  const files = Object.values(pkg.exports)
    .map(target => (typeof target === 'string' ? target : target.import))
    .filter(target => target.startsWith('./dist/'))
    .map(target => sourceOf(target));
  // Leaf modules first, barrels last: a value re-exported by a barrel keeps its declaring file.
  const ordered = [...new Set(files)].toSorted(
    (a, b) => Number(a.endsWith('index.ts')) - Number(b.endsWith('index.ts')) || a.localeCompare(b),
  );

  const keyOf = new Map<unknown, string>();
  const sourceText = new Map<string, string>();
  const textOf = (file: string) => {
    let text = sourceText.get(file);
    if (text === undefined) {
      text = readFileSync(srcDir + file, 'utf8');
      sourceText.set(file, text);
    }
    return text;
  };

  const modules: [string, Record<string, unknown>][] = [];
  for (const file of ordered) {
    const loaded: Record<string, unknown> = await import(srcDir + file);
    modules.push([file, loaded]);
  }
  // Declaring files win; a value only re-exported keeps the first module that exports it.
  for (const pass of ['declared', 'any'] as const) {
    for (const [file, loaded] of modules) {
      for (const [name, value] of Object.entries(loaded)) {
        if (typeof value !== 'function' || keyOf.has(value)) continue;
        if (pass === 'declared' && !declares(textOf(file), name)) continue;
        keyOf.set(value, `${file}::${name}`);
      }
    }
  }

  const operations: string[] = [];
  const structural = new Map<string, StructuralExemption>();
  for (const [value, key] of keyOf) {
    const [file = '', name = ''] = key.split('::');
    if (isFailureDefinition(value)) {
      structural.set(key, 'failure definition');
      continue;
    }
    if (!isClass(value)) {
      operations.push(key);
      continue;
    }
    const body = classBody(textOf(file), name);
    const abstract = new RegExp(`abstract\\s+class\\s+${name}\\b`).test(textOf(file));
    if (value.prototype instanceof Error) structural.set(key, 'error class');
    else if (abstract) structural.set(key, 'abstract class');
    // A private constructor is no operation: callers build the class through its `static create`.
    else if (!/\bprivate\s+constructor\s*\(/.test(body)) operations.push(key);
    const prototype: unknown = value.prototype;
    for (const method of Object.getOwnPropertyNames(prototype)) {
      if (method === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      if (typeof descriptor?.value !== 'function' || isHidden(body, method)) continue;
      operations.push(`${key}.${method}`);
    }
    for (const method of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, method);
      if (typeof descriptor?.value !== 'function' || isHidden(body, method)) continue;
      operations.push(`${key}.${method}`);
    }
  }

  return { operations: operations.toSorted(), structural };
}
