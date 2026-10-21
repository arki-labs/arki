import { createFileRoute } from '@tanstack/react-router';

import securityPolicy from '~/content/security/SECURITY.md?raw';

// The one place the reporting address lives is the root SECURITY.md; `bun release:arki site` copies it into the app
// because the Docker image has no repo-root files. Failing at load beats serving a file with no contact.
const repositoryUrl = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.exec(securityPolicy)?.[0];
if (!repositoryUrl) throw new Error('SECURITY.md must name the GitHub repository that takes private reports.');

const contact = `${repositoryUrl}/security/advisories/new`;
const policy = `${repositoryUrl}/security/policy`;

/** RFC 9116 asks for an `Expires` date. One year ahead of the moment the file is served keeps it from going stale. */
function expiresInOneYear(now: Date): string {
  const expires = new Date(now);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  return expires.toISOString();
}

export const Route = createFileRoute('/.well-known/security.txt')({
  server: {
    handlers: {
      GET: () =>
        new Response(
          [
            `Contact: ${contact}`,
            `Expires: ${expiresInOneYear(new Date())}`,
            `Policy: ${policy}`,
            'Preferred-Languages: en',
            '',
          ].join('\n'),
          { headers: { 'content-type': 'text/plain; charset=utf-8' } },
        ),
    },
  },
});
