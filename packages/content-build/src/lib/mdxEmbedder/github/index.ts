import { z } from '@arki/contracts';

import type { GitHubEmbed } from '../embeds.js';
import { parseWith } from '../utils.js';

const authorSchema = z.object({ login: z.string(), avatarUrl: z.string(), url: z.string() });

/** An issue or pull request as its snapshot stores it: the fields the GitHub card shows. */
export const gitHubItemSchema = z.object({
  number: z.number(),
  url: z.string(),
  titleHTML: z.string(),
  createdAt: z.string(),
  author: authorSchema,
});

export type Issue = z.infer<typeof gitHubItemSchema>;

const responseSchema = z.object({ data: z.object({ repository: z.object({ item: gitHubItemSchema }) }) });

const query = (field: 'issue' | 'pullRequest') => `query item($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    item: ${field}(number: $number) { number url titleHTML createdAt author { login avatarUrl url } }
  }
}`;

/** Fetches an issue or pull request from GitHub's GraphQL API, which needs `GITHUB_TOKEN`. */
export async function fetchGitHubItem(embed: GitHubEmbed): Promise<Issue> {
  // eslint-disable-next-line turbo/no-undeclared-env-vars -- read only by `arki-content snapshot`, never by a turbo task
  const token = process.env['GITHUB_TOKEN'];
  if (!token) throw new Error('GITHUB_TOKEN is not set (the GitHub GraphQL API needs a token)');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: query(embed.kind === 'issue' ? 'issue' : 'pullRequest'),
      variables: { owner: embed.owner, repo: embed.repo, number: embed.number },
    }),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText}`);
  return parseWith(responseSchema, await response.json(), `GitHub's answer for ${embed.url}`).data.repository.item;
}
