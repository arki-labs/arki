import type { AnchorHTMLAttributes, HTMLAttributes, ImgHTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import type { TweetProps } from 'react-tweet';
import { Tweet } from 'react-tweet';

import type { CalloutProps } from '@arki/ui/callout';
import { Callout } from '@arki/ui/callout';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@arki/ui/table';
import { Hash } from '@arki/icons/phosphor';

import type { FileTreeProps } from './FileTree';
import { FileTree } from './FileTree';
import { GitHubIssue, GitHubPullRequest } from './GitHub';
import MarkdownImage from './MarkdownImage';
import { Notification } from './notification';
import Pre from './pre';
import { StaticTweet } from './StaticTweet';

type HeadingProps = {
  id?: string;
  children?: ReactNode;
};

const heading = (As: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') => {
  const Heading = ({ id, children }: HeadingProps) => (
    <a href={`#${id}`} className="group relative no-underline focus-visible:ring-0">
      <Hash
        className="text-primary-500 dark:text-primary-400 absolute -left-5 hidden h-full p-1 group-hover:block group-focus-visible:block sm:-left-6"
        strokeWidth="3"
      />
      <As
        id={id}
        className="group-focus-visible:decoration-primary-500 group-focus-visible:underline group-focus-visible:decoration-2"
      >
        {children}
      </As>
    </a>
  );
  Heading.displayName = As;
  return Heading;
};

export const components = {
  a: ({ href = '', ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
    if (href.startsWith('http')) {
      return (
        <a
          className="text-foreground underline underline-offset-4 hover:no-underline"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
        />
      );
    }

    return <a href={href} className="text-foreground underline underline-offset-4 hover:no-underline" {...props} />;
  },
  Tweet: (props: TweetProps) => {
    return (
      <div data-theme="light" className="not-prose [&>div]:mx-auto">
        <Tweet {...props} />
      </div>
    );
  },
  Image: (props: ImgHTMLAttributes<HTMLImageElement>) => <img loading="lazy" decoding="async" {...props} />,
  img: MarkdownImage,
  Callout: (props: CalloutProps) => {
    return (
      <div className="not-prose my-5">
        <Callout {...props} />
      </div>
    );
  },
  Notification,
  GitHubIssue,
  GitHubPullRequest,
  StaticTweet,
  FileTree: (props: FileTreeProps) => <FileTree {...props} />,
  table: (props: HTMLAttributes<HTMLTableElement>) => <Table {...props} />,
  thead: (props: HTMLAttributes<HTMLTableSectionElement>) => <TableHeader {...props} />,
  tbody: (props: HTMLAttributes<HTMLTableSectionElement>) => <TableBody {...props} />,
  tfoot: (props: HTMLAttributes<HTMLTableSectionElement>) => <TableFooter {...props} />,
  tr: (props: HTMLAttributes<HTMLTableRowElement>) => <TableRow {...props} />,
  th: (props: ThHTMLAttributes<HTMLTableCellElement>) => <TableHead {...props} />,
  td: (props: TdHTMLAttributes<HTMLTableCellElement>) => <TableCell {...props} />,
  pre: (props: HTMLAttributes<HTMLPreElement>) => <Pre {...props} />,
  h1: heading('h1'),
  h2: heading('h2'),
  h3: heading('h3'),
  h4: heading('h4'),
  h5: heading('h5'),
  h6: heading('h6'),
};
