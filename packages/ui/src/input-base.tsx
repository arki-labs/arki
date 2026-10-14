'use client';

import * as React from 'react';

import { Button } from './button';
import { cn } from './cn';

/** Merge multiple refs into a single callback ref. */
function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (value) => {
    refs.forEach((ref) => {
      if (typeof ref === 'function') ref(value);
      else if (ref != null) (ref as React.MutableRefObject<T | null>).current = value;
    });
  };
}

/** Call originalHandler then ourHandler, both with the same event. */
function composeEventHandlers<E>(
  originalHandler: ((event: E) => void) | undefined,
  ourHandler: (event: E) => void,
): (event: E) => void {
  return (event: E) => {
    originalHandler?.(event);
    ourHandler(event);
  };
}

export type InputBaseContextProps = Pick<InputBaseProps, 'autoFocus' | 'disabled'> & {
  controlRef: React.RefObject<HTMLElement | null>;
  onFocusedChange: (focused: boolean) => void;
};

const InputBaseContext = React.createContext<InputBaseContextProps>({
  autoFocus: false,
  controlRef: { current: null },
  disabled: false,
  onFocusedChange: () => {},
});

const useInputBaseContext = () => React.useContext(InputBaseContext);

export type InputBaseProps = {
  autoFocus?: boolean;
  disabled?: boolean;
} & React.ComponentPropsWithoutRef<'div'>;

export const InputBase = React.forwardRef<HTMLDivElement, InputBaseProps>(
  ({ autoFocus, disabled, className, onClick, ...props }, ref) => {
    const [focused, setFocused] = React.useState(false);

    const controlRef = React.useRef<HTMLElement>(null);

    return (
      <InputBaseContext.Provider
        value={{
          autoFocus,
          controlRef,
          disabled,
          onFocusedChange: setFocused,
        }}
      >
        <div
          ref={ref}
          onClick={composeEventHandlers(onClick, (event) => {
            // Based on MUI's <InputBase /> implementation.
            // https://github.com/mui/material-ui/blob/master/packages/mui-material/src/InputBase/InputBase.js#L458~L460
            if (controlRef.current && event.currentTarget === event.target) {
              controlRef.current.focus();
            }
          })}
          className={cn(
            'border-input flex min-h-9 cursor-text items-center gap-2 rounded-md border bg-transparent px-3 py-1 text-sm shadow-sm transition-colors',
            disabled && 'cursor-not-allowed opacity-50',
            focused && 'ring-ring ring-1',
            className,
          )}
          {...props}
        />
      </InputBaseContext.Provider>
    );
  },
);
InputBase.displayName = 'InputBase';

export const InputBaseFlexWrapper = React.forwardRef<HTMLDivElement, React.ComponentPropsWithoutRef<'div'>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex flex-1 flex-wrap', className)} {...props} />
  ),
);
InputBaseFlexWrapper.displayName = 'InputBaseFlexWrapper';

export type InputBaseControlProps = React.HTMLAttributes<HTMLElement> & {
  disabled?: boolean;
  children?: React.ReactNode;
};

export const InputBaseControl = React.forwardRef<HTMLElement, InputBaseControlProps>(
  ({ onFocus, onBlur, children, ...props }, ref) => {
    const { controlRef, autoFocus, disabled, onFocusedChange } = useInputBaseContext();

    if (!React.isValidElement(children)) return null;

    const child = children as React.ReactElement<Record<string, unknown>>;
    const childRef = (children as { ref?: React.Ref<HTMLElement> }).ref;

    return React.cloneElement(child, {
      ...child.props,
      ...props,
      ref: mergeRefs(controlRef as React.Ref<HTMLElement>, ref as React.Ref<HTMLElement>, childRef),
      autoFocus: autoFocus,
      disabled: disabled,
      onFocus: composeEventHandlers(onFocus as (event: React.FocusEvent<HTMLElement>) => void, () =>
        onFocusedChange(true),
      ),
      onBlur: composeEventHandlers(onBlur as (event: React.FocusEvent<HTMLElement>) => void, () =>
        onFocusedChange(false),
      ),
    });
  },
);
InputBaseControl.displayName = 'InputBaseControl';

export type InputBaseAdornmentProps = {
  asChild?: boolean;
  disablePointerEvents?: boolean;
} & React.ComponentPropsWithoutRef<'div'>;

export const InputBaseAdornment = React.forwardRef<HTMLDivElement, InputBaseAdornmentProps>(
  ({ className, disablePointerEvents, asChild, children, ...props }, ref) => {
    const isAction = React.isValidElement(children) && children.type === InputBaseAdornmentButton;

    const mergedClassName = cn(
      'text-muted-foreground flex items-center [&_svg]:size-4',
      (!isAction || disablePointerEvents) && 'pointer-events-none',
      className,
    );

    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>, {
        ...(children as React.ReactElement<React.HTMLAttributes<HTMLElement>>).props,
        ...props,
        ref: ref as React.Ref<HTMLElement>,
        className: cn(
          mergedClassName,
          (children as React.ReactElement<{ className?: string }>).props.className,
        ),
      } as React.HTMLAttributes<HTMLElement>);
    }

    const Comp = typeof children === 'string' ? 'p' : 'div';

    return (
      <Comp ref={ref as React.Ref<HTMLDivElement>} className={mergedClassName} {...props}>
        {children}
      </Comp>
    );
  },
);
InputBaseAdornment.displayName = 'InputBaseAdornment';

export const InputBaseAdornmentButton = React.forwardRef<
  HTMLButtonElement,
  React.ComponentPropsWithoutRef<typeof Button>
>(({ type = 'button', variant = 'ghost', size = 'icon', disabled: disabledProp, className, ...props }, ref) => {
  const { disabled } = useInputBaseContext();

  return (
    <Button
      ref={ref}
      type={type}
      variant={variant}
      size={size}
      disabled={disabled || disabledProp}
      className={cn('size-6', className)}
      {...props}
    />
  );
});
InputBaseAdornmentButton.displayName = 'InputBaseAdornmentButton';

export const InputBaseInput = React.forwardRef<HTMLInputElement, React.ComponentPropsWithoutRef<'input'>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'placeholder:text-muted-foreground w-full flex-1 bg-transparent file:border-0 file:bg-transparent file:text-sm file:font-medium focus:outline-none disabled:pointer-events-none',
        className,
      )}
      {...props}
    />
  ),
);
InputBaseInput.displayName = 'InputBaseInput';
