import Link from 'next/link';

import { cn } from '@arki/base-ui/cn';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@arki/base-ui/hover-card';
import { ArrowUpRight } from '@arki/icons';

type FooterLinkProps = {
  href: string;
  label?: string;
  external?: boolean;
  title?: string;
  children?: React.ReactNode;
  className?: string;
};

export function EnhancedLink({ href, label, external = false, title, children, className }: Readonly<FooterLinkProps>) {
  const isExternal = external || href.startsWith('http');

  const LinkSlot = isExternal ? HoverCardTrigger : Link;

  const externalProps = isExternal
    ? {
        target: '_blank',
        rel: 'noreferrer',
      }
    : {};

  return (
    <HoverCard>
      <LinkSlot
        className={cn(isExternal ? 'underline underline-offset-4 hover:no-underline' : '', 'w-full', className)}
        href={href}
        {...externalProps}
      >
        <span className="inline-flex items-center gap-3 [&>svg]:size-4">
          {children ?? label}
          {isExternal ? <ArrowUpRight className="ml-1 h-4 w-4 shrink-0" /> : null}
        </span>
      </LinkSlot>
      {title ? <HoverCardContent>{title}</HoverCardContent> : null}
    </HoverCard>
  );
}
