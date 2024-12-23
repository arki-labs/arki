import type { ComponentProps } from 'react';
import type { ControllerProps, FieldPath, FieldValues } from 'react-hook-form';
import { createContext, Fragment, useContext, useId } from 'react';
import { Slot } from '@radix-ui/react-slot';
import { Controller, FormProvider, useFormContext } from 'react-hook-form';

import { Button } from './button';
import { cn } from './cn';
import { Label } from './label';

const Form = FormProvider;

type FormFieldContextValue<
  TFieldValues extends FieldValues = FieldValues,
  TName extends FieldPath<TFieldValues> = FieldPath<TFieldValues>,
> = {
  name: TName;
};

const FormFieldContext = createContext<FormFieldContextValue>({} as FormFieldContextValue);

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
  const fieldContext = useContext(FormFieldContext);
  const itemContext = useContext(FormItemContext);
  const { getFieldState, formState } = useFormContext();

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

const FormItemContext = createContext<FormItemContextValue>({} as FormItemContextValue);

function FormItem({ className, ...props }: ComponentProps<'div'>) {
  const id = useId();

  return (
    <FormItemContext.Provider value={{ id }}>
      <div className={cn('space-y-2', className)} {...props} />
    </FormItemContext.Provider>
  );
}
FormItem.displayName = 'FormItem';

function FormLabel({ className, ...props }: ComponentProps<typeof Label>) {
  const { error, formItemId } = useFormField();

  return <Label className={cn(error && 'text-destructive', className)} htmlFor={formItemId} {...props} />;
}
FormLabel.displayName = 'FormLabel';

function FormControl({ ...props }: ComponentProps<typeof Slot>) {
  const { error, formItemId, formDescriptionId, formMessageId } = useFormField();

  return (
    <Slot
      id={formItemId}
      aria-describedby={error ? `${formDescriptionId} ${formMessageId}` : `${formDescriptionId}`}
      aria-invalid={!!error}
      {...props}
    />
  );
}
FormControl.displayName = 'FormControl';

function FormHints({ className, hints, ...props }: ComponentProps<'div'> & { hints: any[] }) {
  const { setValue } = useFormContext();
  const { name } = useFormField();
  const id = useId();

  return (
    <div className={cn('space-y-1', className)} {...props}>
      {hints.map((hint, index) => (
        <Fragment key={`${id}-${name}-hint-${hint}`}>
          <Button
            variant="text"
            size="xs"
            className="p-0"
            onClick={() => {
              setValue(name, hint, { shouldValidate: false });
            }}
          >
            {hint}
          </Button>
          {index < hints.length - 1 && <span className="text-muted-foreground">, </span>}
        </Fragment>
      ))}
    </div>
  );
}
FormHints.displayName = 'FormHints';

function FormDescription({ className, ...props }: ComponentProps<'p'>) {
  const { formDescriptionId } = useFormField();

  return <p id={formDescriptionId} className={cn('text-[0.8rem] text-muted-foreground', className)} {...props} />;
}
FormDescription.displayName = 'FormDescription';

function FormMessage({ className, children, ...props }: ComponentProps<'p'>) {
  const { error, formMessageId } = useFormField();
  const body = error ? String(error.message) : children;

  if (!body) {
    return null;
  }

  return (
    <p id={formMessageId} className={cn('text-[0.8rem] font-medium text-destructive', className)} {...props}>
      {body}
    </p>
  );
}
FormMessage.displayName = 'FormMessage';

export { useFormField, Form, FormItem, FormLabel, FormControl, FormDescription, FormMessage, FormField, FormHints };
