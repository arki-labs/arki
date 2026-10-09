import type { ButtonHTMLAttributes, ComponentProps } from 'react';

import type { ButtonProps } from './button';
import { Button } from './button';
import { cn } from './cn';
import { Surface } from './surface';

export type ToolbarWrapperProps = {
  shouldShowContent?: boolean;
  isVertical?: boolean;
} & ComponentProps<'div'>;

function ToolbarWrapper({
  shouldShowContent = true,
  children,
  isVertical = false,
  className,
  ...rest
}: ToolbarWrapperProps) {
  const toolbarClassName = cn(
    'inline-flex h-full gap-0.5 leading-none text-black',
    isVertical ? 'flex-col p-2' : 'flex-row items-center p-1',
    className,
  );

  return (
    shouldShowContent && (
      <Surface className={toolbarClassName} {...rest}>
        {children}
      </Surface>
    )
  );
}

ToolbarWrapper.displayName = 'Toolbar';

export type ToolbarDividerProps = {
  horizontal?: boolean;
} & ComponentProps<'div'>;

function ToolbarDivider({ horizontal, className, ...rest }: ToolbarDividerProps) {
  const dividerClassName = cn(
    'bg-neutral-200 dark:bg-neutral-800',
    horizontal
      ? 'my-1 h-[1px] w-full min-w-[1.5rem] first:mt-0 last:mt-0'
      : 'mx-1 h-full min-h-[1.5rem] w-[1px] first:ml-0 last:mr-0',
    className,
  );

  return <div className={dividerClassName} {...rest} />;
}

ToolbarDivider.displayName = 'Toolbar.Divider';

export type ToolbarButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  tooltip?: string;
  tooltipShortcut?: string[];
  buttonSize?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
};

function ToolbarButton({
  children,
  buttonSize = 'icon',
  variant = 'ghost',
  className,
  tooltip,
  tooltipShortcut,
  ...rest
}: ToolbarButtonProps) {
  const buttonClass = cn('w-auto min-w-[2rem] gap-1 px-2', className);

  const content = (
    <Button className={buttonClass} variant={variant} size={buttonSize} {...rest}>
      {children}
    </Button>
  );

  return content;
}

ToolbarButton.displayName = 'ToolbarButton';

export const Toolbar = {
  Wrapper: ToolbarWrapper,
  Divider: ToolbarDivider,
  Button: ToolbarButton,
};
