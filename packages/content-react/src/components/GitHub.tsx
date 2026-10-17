import { GithubLogo } from '@arki/icons/phosphor';

import DateTime from './DateTime';
import EmbeddedCard from './EmbeddedCard';

/**
 * An issue or pull request as the card shows it. `@arki/content-build` writes these props into the compiled MDX
 * from the embed snapshot (`src/content/.embeds/`), so the fields match its snapshot schema.
 */
export type GitHubItem = {
  number: number;
  url: string;
  titleHTML: string;
  createdAt: string;
  author: { login: string; avatarUrl: string; url: string };
};

export type Repository = { owner: string; name: string };

type Props =
  | {
      type: 'Pull Request';
      entity: GitHubItem;
      repository: Repository;
    }
  | {
      type: 'Issue';
      entity: GitHubItem;
      repository: Repository;
    };

const EmbeddedEntity = ({ repository, entity, type }: Props) => (
  <EmbeddedCard href={entity.url}>
    <EmbeddedCard.Title icon={GithubLogo}>
      <p className="text-lg font-bold">
        <span className="text-base-500 dark:text-base-400">
          {repository.owner}/{repository.name}
        </span>{' '}
        <span dangerouslySetInnerHTML={{ __html: entity.titleHTML }} />
      </p>
    </EmbeddedCard.Title>
    <p className="text-sm">
      {type} #{entity.number} opened on <DateTime value={entity.createdAt} /> by
    </p>
    <EmbeddedCard.Author
      name={entity.author.login}
      avatar={{ src: entity.author.avatarUrl, alt: `Profile of ${entity.author.login}` }}
    />
  </EmbeddedCard>
);

type PullRequestProps = {
  repository: Repository;
  pullRequest: GitHubItem;
};

export const GitHubPullRequest = ({ pullRequest, repository }: PullRequestProps) => (
  <EmbeddedEntity type="Pull Request" repository={repository} entity={pullRequest} />
);

type IssueProps = {
  repository: Repository;
  issue: GitHubItem;
};

export const GitHubIssue = ({ repository, issue }: IssueProps) => (
  <EmbeddedEntity type="Issue" repository={repository} entity={issue} />
);
