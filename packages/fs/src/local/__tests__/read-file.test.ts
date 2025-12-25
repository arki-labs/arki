import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encode } from 'iconv-lite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readFile } from '../read-file';

const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

describe('readFile', () => {
  beforeAll(() => {
    // Suppress console.debug output during tests
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('UTF-8 encoding', () => {
    it('reads a UTF-8 file correctly', () => {
      const filePath = join(FIXTURES_DIR, 'utf8.txt');
      const content = readFile(filePath, 'utf8');

      expect(content).toContain('Hello, World!');
      expect(content).toContain('UTF-8 encoded file');
      expect(content).toContain('áéíóú ñ € £ ¥');
    });

    it('uses buffer.toString() for utf8 encoding', () => {
      const filePath = join(FIXTURES_DIR, 'utf8.txt');
      const content = readFile(filePath, 'utf8');

      expect(typeof content).toBe('string');
      expect(content.length).toBeGreaterThan(0);
    });
  });

  describe('non-UTF-8 encodings', () => {
    const latin1FilePath = join(FIXTURES_DIR, 'latin1.txt');
    const latin1Content = 'Héllo Wörld! Ñoño';

    beforeAll(() => {
      // Create a Latin-1 encoded file for testing
      const buffer = encode(latin1Content, 'latin1');
      writeFileSync(latin1FilePath, buffer);
    });

    it('reads a Latin-1 (ISO-8859-1) file correctly', () => {
      const content = readFile(latin1FilePath, 'latin1');

      expect(content).toBe(latin1Content);
    });

    it('reads a file with iso-8859-1 encoding alias', () => {
      const content = readFile(latin1FilePath, 'iso-8859-1');

      expect(content).toBe(latin1Content);
    });
  });

  describe('Windows encodings', () => {
    const win1252FilePath = join(FIXTURES_DIR, 'win1252.txt');
    const win1252Content = 'Windows encoding: "smart quotes" and €';

    beforeAll(() => {
      // Create a Windows-1252 encoded file for testing
      const buffer = encode(win1252Content, 'win1252');
      writeFileSync(win1252FilePath, buffer);
    });

    it('reads a Windows-1252 file correctly', () => {
      const content = readFile(win1252FilePath, 'win1252');

      expect(content).toBe(win1252Content);
    });
  });

  describe('edge cases', () => {
    it('handles empty files', () => {
      const emptyFilePath = join(FIXTURES_DIR, 'empty.txt');
      writeFileSync(emptyFilePath, '');

      const content = readFile(emptyFilePath, 'utf8');

      expect(content).toBe('');
    });

    it('throws an error for non-existent files', () => {
      const nonExistentPath = join(FIXTURES_DIR, 'non-existent.txt');

      expect(() => readFile(nonExistentPath, 'utf8')).toThrow();
    });
  });
});
