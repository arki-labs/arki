import type { LinkProps } from 'next/link';
import Link from 'next/link';
import { LuChevronLeft } from 'react-icons/lu';

import { Button } from '@arki/base-ui/button';

type BackButtonProps = {
  children?: React.ReactNode;
} & LinkProps<any>;

export const BackButton = ({ href, children }: BackButtonProps) => {
  return (
    <Button variant="link" asChild>
      <Link href={href} className="group mb-1">
        <LuChevronLeft className="mr-1 h-4 w-4 text-muted-foreground group-hover:text-foreground" />{' '}
        {children || 'Back'}
      </Link>
    </Button>
  );
};
