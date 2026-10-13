import { afterEach, describe, expect, it, vi } from 'vitest';

import { Configuration } from './config.js';
import { Severity } from './types.js';

describe('Configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults severity to INFO without LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', '');
    expect(new Configuration().severity).toBe(Severity.INFO);
  });

  it('reads severity from LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'DEBUG');
    expect(new Configuration().severity).toBe(Severity.DEBUG);
  });

  it('falls back to INFO for an unknown LOG_LEVEL', () => {
    vi.stubEnv('LOG_LEVEL', 'nonsense');
    expect(new Configuration().severity).toBe(Severity.INFO);
  });

  it('turns DEBUG names into DEBUG severity for those loggers only', () => {
    vi.stubEnv('LOG_LEVEL', '');
    vi.stubEnv('DEBUG', 'a,b');
    const config = new Configuration();
    expect(config.getSeverity('a')).toBe(Severity.DEBUG);
    expect(config.getSeverity('c')).toBe(config.severity);
    expect(config.getSeverity('c')).toBe(Severity.INFO);
  });

  it('setDebug replaces the debug names', () => {
    vi.stubEnv('DEBUG', '');
    const config = new Configuration();
    config.setDebug('x,y');
    expect(config.getSeverity('y')).toBe(Severity.DEBUG);
    expect(config.getSeverity('z')).toBe(Severity.INFO);
  });

  it('configureBatching sets the given fields and keeps the rest', () => {
    const config = new Configuration();
    config.configureBatching({ batchLogging: true, maxBatchSize: 5 });
    expect(config.batchLogging).toBe(true);
    expect(config.maxBatchSize).toBe(5);
    expect(config.autoFlushMs).toBe(5000);
  });
});
