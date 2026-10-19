import { oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { asTool } from './contract.js';

describe('asTool', () => {
  it('retains existing authorization metadata without changing the source procedure', () => {
    const policy = { roles: ['admin'] };
    const procedure = oc.$meta<{ policy: typeof policy }>({ policy }).input(z.string());
    const before = procedure['~orpc'];

    const tool = asTool(procedure, {
      description: 'Find an account.',
      access: { roles: ['admin'] },
      effect: 'read',
    });

    expect(tool).not.toBe(procedure);
    expect(tool['~orpc']).not.toBe(before);
    expect(tool['~orpc'].meta).not.toBe(before.meta);
    expect(tool['~orpc'].meta.policy).toBe(policy);
    expect(procedure['~orpc']).toBe(before);
    expect(before.meta).toEqual({ policy });
    expect(tool['~orpc'].meta.mcp.description).toBe('Find an account.');
  });

  it('reuses the canonical schemas, error map and route instead of deriving parallel definitions', () => {
    const procedure = oc
      .input(z.object({ id: z.string() }))
      .output(z.object({ name: z.string() }))
      .errors({ NOT_FOUND: { data: z.object({ id: z.string() }) } })
      .route({ method: 'GET', path: '/accounts/{id}' });
    const tool = asTool(procedure, {
      description: 'Find an account.',
      access: 'user',
      effect: 'read',
      remediation: { NOT_FOUND: 'List accounts to choose an existing ID.' },
    });

    expect(tool['~orpc'].inputSchema).toBe(procedure['~orpc'].inputSchema);
    expect(tool['~orpc'].outputSchema).toBe(procedure['~orpc'].outputSchema);
    expect(tool['~orpc'].errorMap).toBe(procedure['~orpc'].errorMap);
    expect(tool['~orpc'].route).toBe(procedure['~orpc'].route);
    expect(tool['~orpc'].meta.mcp.remediation.NOT_FOUND).toBe('List accounts to choose an existing ID.');
  });

  it('preserves destructive confirmation and hidden declarations for adapters to enforce', () => {
    const metadata = {
      description: 'Remove the account permanently.',
      access: { scopes: ['accounts:delete'] },
      effect: 'destructive',
      confirm: 'elicit',
      hidden: true,
    } as const;

    const tool = asTool(oc.input(z.string()), metadata);

    expect(tool['~orpc'].meta.mcp).toBe(metadata);
  });
});
