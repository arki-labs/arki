'use client';

import type { VariantProps } from 'class-variance-authority';
import { type ComponentProps } from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

const labelVariants = cva('text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70');

function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root> & VariantProps<typeof labelVariants>) {
  return <LabelPrimitive.Root className={cn(labelVariants(), className)} {...props} />;
}
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
