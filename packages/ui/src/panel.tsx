import type { ComponentProps } from 'react';
import { cn } from './cn';
import { Slot } from './slot';
import { Surface } from './surface';

export type PanelProps = {
  spacing?: 'medium' | 'small';
  noShadow?: boolean;
  asChild?: boolean;
} & ComponentProps<'div'>;

export function Panel({ asChild, className, children, spacing, noShadow, ...rest }: PanelProps) {
  const panelClass = cn('p-2', spacing === 'small' && 'p-[0.2rem]', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp {...rest}>
      <Surface className={panelClass} withShadow={!noShadow}>
        {children}
      </Surface>
    </Comp>
  );
}

Panel.displayName = 'Panel';

export type PanelDividerProps = {
  asChild?: boolean;
} & ComponentProps<'div'>;

export function PanelDivider({ asChild, className, children, ...rest }: PanelDividerProps) {
  const dividerClass = cn('mb-2 border-b border-b-black/10 pb-2', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp className={dividerClass} {...rest}>
      {children}
    </Comp>
  );
}

PanelDivider.displayName = 'PanelDivider';

export type PanelHeaderProps = {
  asChild?: boolean;
} & ComponentProps<'div'>;

export function PanelHeader({ asChild, className, children, ...rest }: PanelHeaderProps) {
  const headerClass = cn('mb-2 border-b border-b-black/10 pb-2 text-sm', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp className={headerClass} {...rest}>
      {children}
    </Comp>
  );
}

PanelHeader.displayName = 'PanelHeader';

export type PanelSectionProps = {
  asChild?: boolean;
} & ComponentProps<'div'>;

export function PanelSection({ asChild, className, children, ...rest }: PanelSectionProps) {
  const sectionClass = cn('mt-4 first:mt-1', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp className={sectionClass} {...rest}>
      {children}
    </Comp>
  );
}

PanelSection.displayName = 'PanelSection';

export type PanelHeadlineProps = {
  asChild?: boolean;
} & ComponentProps<'div'>;

export function PanelHeadline({ asChild, className, children, ...rest }: PanelHeadlineProps) {
  const headlineClass = cn('mb-2 ml-1.5 text-xs font-medium text-black/80 dark:text-white/80', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp className={headlineClass} {...rest}>
      {children}
    </Comp>
  );
}

PanelHeadline.displayName = 'PanelHeadline';

export type PanelFooterProps = {
  asChild?: boolean;
} & ComponentProps<'div'>;

export function PanelFooter({ asChild, className, children, ...rest }: PanelFooterProps) {
  const footerClass = cn('mt-2 border-t border-black/10 pt-2 text-sm', className);

  const Comp = asChild ? Slot : 'div';

  return (
    <Comp className={footerClass} {...rest}>
      {children}
    </Comp>
  );
}

PanelFooter.displayName = 'PanelFooter';
