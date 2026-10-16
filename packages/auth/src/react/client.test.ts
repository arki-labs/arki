import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { AuthDefinition } from '../definition.js';
import { defineAuth } from '../definition.js';
import { AUTH_ERROR_CODES } from '../errors.js';
import { createAuthClient, definitionClientPlugins, workspacesClientPlugins } from './client.js';

const BASE_URL = 'http://notes.test';

const passwordAndGoogle = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['password', 'google'] });
const magicOnly = defineAuth({ app: { name: 'Notes', key: 'notes' }, methods: ['magicLink'] });
const withWorkspaces = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  workspaces: { teams: true },
});
const withoutTeams = defineAuth({
  app: { name: 'Notes', key: 'notes' },
  methods: ['password'],
  workspaces: { teams: false },
});

/** A fetch that records each request and answers `null` (no session). */
function recordingFetch() {
  const requests: Request[] = [];
  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return Promise.resolve(Response.json(null));
  });
  return { requests, fetch: fetchStub };
}

describe('createAuthClient', () => {
  it('adds the magic-link client plugin only when the definition enables magic links', () => {
    // The client must not offer a method the server refuses: the plugin list follows `methods`.
    expect(definitionClientPlugins(magicOnly).map(plugin => plugin.id)).toEqual(['magic-link']);
    expect(definitionClientPlugins(passwordAndGoogle)).toEqual([]);
  });

  it('types the magic-link API only when the method is on', () => {
    const magic = createAuthClient(magicOnly, { baseURL: BASE_URL });
    expect(typeof magic.signIn.magicLink).toBe('function');
    const password = createAuthClient(passwordAndGoogle, { baseURL: BASE_URL });
    // The guard is the type: at runtime the engine's proxy answers every path (and the server 404s).
    // @ts-expect-error magic links are off for this definition, so the API is not there.
    expect(password.signIn.magicLink).toBeDefined();
  });

  it('carries the capabilities the UI renders from', () => {
    const client = createAuthClient(passwordAndGoogle, { baseURL: BASE_URL });
    expect(client.capabilities).toEqual({
      methods: ['password', 'google'],
      social: ['google'],
      password: true,
      magicLink: false,
      workspaces: false,
    });
    const social: readonly 'google'[] = client.capabilities.social;
    expect(social).toEqual(['google']);
  });

  it('still reaches the engine through the capabilities wrapper', async () => {
    const { requests, fetch } = recordingFetch();
    const client = createAuthClient(passwordAndGoogle, { baseURL: BASE_URL, fetch });
    expect(typeof client.useSession).toBe('function');
    await client.getSession();
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/auth/get-session']);
    expect(new URL(requests[0]?.url ?? '').origin).toBe(BASE_URL);
  });

  it('adds the organization API itself for a workspaces definition, typed from the definition', () => {
    // The server serves the organization routes; the client must offer them without the app wiring a plugin.
    const client = createAuthClient(withWorkspaces, { baseURL: BASE_URL });
    expect(client.capabilities.workspaces).toBe(true);
    expect(typeof client.useActiveOrganization).toBe('function');
    expect(typeof client.organization.createTeam).toBe('function');
    expect(workspacesClientPlugins(withWorkspaces).map(plugin => plugin.id)).toEqual(['organization']);

    const noTeams = createAuthClient(withoutTeams, { baseURL: BASE_URL });
    expect(typeof noTeams.organization.create).toBe('function');
    // Teams follow the definition: the active organization carries teams only when they are on.
    expectTypeOf<(typeof client.$Infer)['ActiveOrganization']>().toHaveProperty('teams');
    expectTypeOf<(typeof noTeams.$Infer)['ActiveOrganization']>().not.toHaveProperty('teams');

    const plain = createAuthClient(passwordAndGoogle, { baseURL: BASE_URL });
    expect(workspacesClientPlugins(passwordAndGoogle)).toEqual([]);
    // The guard is the type (at runtime the engine's proxy answers every key).
    // @ts-expect-error no workspaces in the definition, so no organization API on the client.
    expect(plain.useActiveOrganization).toBeDefined();
  });

  it('types the organization API for a definition written `as const`, without defineAuth', () => {
    const written = {
      app: { name: 'Notes', key: 'notes' },
      methods: ['password'],
      workspaces: { teams: false },
    } as const satisfies AuthDefinition;
    const client = createAuthClient(written, { baseURL: BASE_URL });
    expect(typeof client.organization.create).toBe('function');
    const bare = { app: { name: 'Notes', key: 'notes' }, methods: ['password'] } as const satisfies AuthDefinition;
    // @ts-expect-error no `workspaces` key at all: no organization API.
    expect(createAuthClient(bare, { baseURL: BASE_URL }).organization).toBeDefined();
  });

  it('refuses a definition the server would refuse', () => {
    expect(() =>
      createAuthClient({ app: { name: 'Notes', key: 'Not A Key' }, methods: ['password'] }, { baseURL: BASE_URL }),
    ).toThrow(expect.objectContaining({ code: AUTH_ERROR_CODES.invalidConfig }));
  });
});
