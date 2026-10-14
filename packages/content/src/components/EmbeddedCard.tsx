import type { ReactNode } from 'react';

import type { Icon as LucideIcon } from '@arki/icons/phosphor';
import { AvatarImage } from '@arki/ui/avatar';
import { cn } from '@arki/ui/cn';

type Props = {
  href: string;
  className?: string;
  children?: ReactNode;
};

const EmbeddedCard = ({ href, className, children }: Props) => (
  <div className="not-prose">
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group mb-2 block space-y-2 rounded-md p-5 shadow-md',
        'border-b border-l-8 border-r border-t',
        'border-base-300 dark:border-base-600',
        'hover:border-primary-600 dark:hover:border-primary-400',
        className,
      )}
    >
      {children}
    </a>
  </div>
);

type IconProps = {
  icon: LucideIcon;
  className?: string;
};

const EmbeddedIcon = ({ icon: Icon, className }: IconProps) => (
  <Icon
    className={cn(
      'shrink-0 stroke-2 group-hover:stroke-[3px]',
      'text-base-400 dark:text-base-500',
      'group-hover:text-primary-600 dark:group-hover:text-primary-400',
      className,
    )}
  />
);

type TitleProps = {
  children?: ReactNode;
  icon: LucideIcon;
};

const Title = ({ children, icon }: TitleProps) => (
  <div className="flex justify-between">
    {children}
    <EmbeddedIcon icon={icon} />
  </div>
);

Title.displayName = 'EmbeddedCard.Title';

EmbeddedCard.Title = Title;

type AuthorProps = {
  name: string;
  avatar?: {
    src: string;
    alt: string;
  };
};

const Author = ({ name, avatar }: AuthorProps) => (
  <div className="flex items-center gap-2">
    {avatar ? <AvatarImage src={avatar.src} alt={avatar.alt} className="h-8 w-8" /> : null}

    <p>{name}</p>
  </div>
);

Author.displayName = 'EmbeddedCard.Author';

EmbeddedCard.Author = Author;

export default EmbeddedCard;
