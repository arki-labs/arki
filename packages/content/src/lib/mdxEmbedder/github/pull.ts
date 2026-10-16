import type { Paragraph } from 'mdast';

import type { Author, Repository } from './core.js';
import { createJSONParseAST } from '../utils.js';
import { queryGitHub } from './core.js';

const query = `query pullRequest($owner: String!, $repo: String!, $id: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $id) {
      number
      url
      titleHTML
      createdAt
      author {
        login
        avatarUrl
        url
      }
    }
  }
}`;

export type PullRequest = {
  number: number;
  url: string;
  titleHTML: string;
  createdAt: string;
  author: Author;
};

type Result = {
  data: {
    repository: {
      pullRequest: PullRequest;
    };
  };
};

const fetchPullRequest = async (owner: string, repo: string, id: string) => {
  const variables = {
    owner,
    repo,
    id: Number(id),
  };

  const result = await queryGitHub<Result>(query, variables);
  return result.data.repository.pullRequest;
};

const fetchAndTransformPullRequest = async (node: Paragraph, owner: string, repo: string, id: string) => {
  const pullRequest = await fetchPullRequest(owner, repo, id);
  const repository: Repository = {
    owner,
    name: repo,
  };

  Object.assign(node, {
    type: 'mdxJsxFlowElement',
    name: 'GitHubPullRequest',
    attributes: [
      {
        type: 'mdxJsxAttribute',
        name: 'pullRequest',
        value: {
          type: 'mdxJsxAttributeValueExpression',
          data: {
            estree: createJSONParseAST(JSON.stringify(pullRequest)),
          },
        },
      },
      {
        type: 'mdxJsxAttribute',
        name: 'repository',
        value: {
          type: 'mdxJsxAttributeValueExpression',
          data: {
            estree: createJSONParseAST(JSON.stringify(repository)),
          },
        },
      },
    ],
    children: [],
    position: {},
  });
};

export default fetchAndTransformPullRequest;
