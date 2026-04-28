'use client';

import type { ComponentProps } from 'react';
import type { ControllerProps, FieldPath, FieldValues } from 'react-hook-form';
import * as React from 'react';
import { useId } from 'react';
import { Controller, FormProvider, useFormContext, useFormState } from 'react-hook-form';

import { cn } from './cn';
import { Label } from './label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = React.createContext<FormFieldContextValue>({} as FormFieldContextValue);

const FormField = <
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
>({
  ...props
}: ControllerProps<TFieldValues, TName>) => {
  return (
    <FormFieldContext.Provider value={{ name: props.name }}>
      <Controller {...props} />
    </FormFieldContext.Provider>
  );
};

const useFormField = () => {
  const fieldContext = React.useContext(FormFieldContext);
  const itemContext = React.useContext(FormItemContext);
  const { getFieldState } = useFormContext();
  const formState = useFormState({ name: fieldContext.name });
  const fieldState = getFieldState(fieldContext.name, formState);

  if (!fieldContext) {
    throw new Error('useFormField should be used within <FormField>');
  }

  const { id } = itemContext;

  return {
    id,
    name: fieldContext.name,
    formItemId: `${id}-form-item`,
    formDescriptionId: `${id}-form-item-description`,
    formMessageId: `${id}-form-item-message`,
    ...fieldState,
  };
};

type FormItemContextValue = {
  id: string;
};

const FormItemContext = React.createContext<FormItemContextValue>({} as FormItemContextValue);

function FormItem({ className, ...props }: React.ComponentProps<'div'>) {
  const id = React.useId();

  return (
    <FormItemContext.Provider value={{ id }}>
      <div data-slot="form-item" className={cn('grid gap-2', className)} {...props} />
    </FormItemContext.Provider>
  );
}

function FormLabel({ className, ...props }: React.ComponentProps<'label'>) {
  const { error, formItemId } = useFormField();

  return (
    <Label
      data-slot="form-label"
      data-error={!!error}
      className={cn('data-[error=true]:text-destructive', className)}
      htmlFor={formItemId}
      {...props}
    />
  );
}

type FormControlProps = {
  children: React.ReactElement;
};

function FormControl({ children }: FormControlProps) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();

  // Merge accessibility props into the child form control element via cloneElement.
  // This replaces the Radix Slot pattern, injecting id and aria attributes without
  // adding a wrapper DOM node.
  return React.cloneElement(children, {
    'data-slot': 'form-control',
    id: formItemId,
    'aria-describedby': error ? `${formDescriptionId} ${formMessageId}` : formDescriptionId,
    'aria-invalid': !!error || undefined,
  } as React.HTMLAttributes<HTMLElement>);
}

function FormDescription({ className, ...props }: React.ComponentProps<'p'>) {
  const { formDescriptionId } = useFormField();

  return (
    <p
      data-slot="form-description"
      id={formDescriptionId}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

function FormMessage({ className, ...props }: React.ComponentProps<'p'>) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message) : props.children;

  if (!body) {
    return null;
  }

  return (
    <p
      data-slot="form-message"
      id={formMessageId}
      className={cn('text-sm font-medium text-destructive', className)}
      {...props}
    >
      {body}
    </p>
  );
}

/** A hint item can be a plain value or an object with a custom display label. */
type HintItem<T> = T | { value: T; label: React.ReactNode };

/**
 * Inline ghost-token hints displayed as subtle clickable text separated by `·`.
 * Clicking a hint sets the parent form field to that value.
 */
function FormHints<T extends string | number | Date>({
  className,
  hints,
  onHintClick,
  renderHint,
  ...props
}: Omit<ComponentProps<'div'>, 'children'> & {
  hints: HintItem<T>[];
  onHintClick?: (value: T) => void;
  renderHint?: (value: T) => React.ReactNode;
}) {
  const { setValue } = useFormContext();
  const { name } = useFormField();
  const id = useId();

  const resolved = hints.map((hint) => {
    if (typeof hint === 'object' && hint !== null && !(hint instanceof Date) && 'value' in hint && 'label' in hint) {
      return hint as { value: T; label: React.ReactNode };
    }
    const value = hint as T;
    return { value, label: renderHint?.(value) ?? value.toString() };
  });

  return (
    <TooltipProvider delay={500}>
      <div
        className={cn('flex flex-wrap items-center gap-1 text-xs text-muted-foreground', className)}
        {...props}
      >
        {resolved.map((hint, index) => (
          <React.Fragment key={`${id}-${name}-hint-${index}`}>
            {index > 0 && (
              <span className="select-none text-border" aria-hidden="true">
                ·
              </span>
            )}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="cursor-pointer rounded px-1 py-0.5 tabular-nums transition-colors hover:bg-muted hover:text-foreground"
                    onClick={(e) => {
                      e.preventDefault();
                      setValue(name, hint.value, {
                        shouldDirty: true,
                        shouldTouch: true,
                        shouldValidate: true,
                      });
                      onHintClick?.(hint.value);
                    }}
                  />
                }
              >
                {hint.label}
              </TooltipTrigger>
              <TooltipContent side="top">Click to use this value</TooltipContent>
            </Tooltip>
          </React.Fragment>
        ))}
      </div>
    </TooltipProvider>
  );
}

export type { HintItem };
export { Form, FormControl, FormDescription, FormField, FormHints, FormItem, FormLabel, FormMessage, useFormField };

export { zodResolver } from '@hookform/resolvers/zod';
export { useForm, useWatch } from 'react-hook-form';
