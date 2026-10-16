import type { Provider } from '../provider.js';
import fetchAndTransformIssue from './issue.js';
import fetchAndTransformPullRequest from './pull.js';

const GitHubProvider: Provider = {
  baseUrl: 'https://github.com',
  transform(node, url) {
    const parts = url.split('/').slice(3, 7);
    if (parts.length !== 4) {
      return null;
    }

    const [slug, repo, type, id] = parts;
    if (type === 'pull' && slug && repo && id) {
      return fetchAndTransformPullRequest(node, slug, repo, id);
    } else if (type === 'issues' && slug && repo && id) {
      return fetchAndTransformIssue(node, slug, repo, id);
    } else {
      console.log(`Unsupported github type: ${type}`);
    }

    return null;
  },
};

export default GitHubProvider;

export { type Author, type Repository } from './core.js';
export { type Issue } from './issue.js';
export { type PullRequest } from './pull.js';
