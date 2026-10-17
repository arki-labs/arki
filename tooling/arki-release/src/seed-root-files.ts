/**
 * Test support: the root files `export-public` copies into every public tree
 * (it throws when one is missing). One helper, so a new community file is
 * added to every fixture root in one place.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { COMMUNITY_FILES, ISSUE_TEMPLATE_DIR } from './export-public';

/** Typed by `COMMUNITY_FILES`: adding a community file fails typecheck until it is seeded here. */
const COMMUNITY_TEXT = {
  'SECURITY.md': '# Security policy\n',
  'CONTRIBUTING.md': '# Contributing\n',
} as const satisfies Record<(typeof COMMUNITY_FILES)[number], string>;

const ISSUE_TEMPLATES = {
  'bug.yml': 'name: Bug\n',
  'feature.yml': 'name: Feature\n',
  'config.yml': 'blank_issues_enabled: false\n',
} as const;

/** Writes the community files and issue forms under `root`. */
export function seedRootFiles(root: string): void {
  const write = (relPath: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    writeFileSync(path.join(root, relPath), text, 'utf8');
  };
  for (const file of COMMUNITY_FILES) write(file, COMMUNITY_TEXT[file]);
  for (const [name, text] of Object.entries(ISSUE_TEMPLATES)) write(path.join(ISSUE_TEMPLATE_DIR, name), text);
}
