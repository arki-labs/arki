'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';

import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from '@arki/icons';

import { buttonVariants } from './button';
import { cn } from './cn';

function Calendar({ className, classNames, showOutsideDays = true, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-row sm:flex-col gap-2',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center w-full',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1 relative justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'absolute top-5 left-1 size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'absolute top-5 right-1 size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
        ),
        table: 'w-full border-collapse space-x-1',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-8 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: cn(
          buttonVariants({ variant: 'ghost' }),
          '[&:has([aria-selected])]:bg-accent [&:has([aria-selected].day-outside)]:bg-accent/50 relative size-8 p-0 text-center text-sm font-normal focus-within:relative focus-within:z-20 aria-selected:opacity-100 [&:has([aria-selected].day-range-end)]:rounded-r-md',
          props.mode === 'range'
            ? '[&:has(>.day-range-end)]:rounded-r-md [&:has(>.day-range-start)]:rounded-l-md first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md'
            : '[&:has([aria-selected])]:rounded-md',
        ),
        range_start: 'day-range-start',
        range_end: 'day-range-end',
        selected:
          'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground',
        today: 'bg-accent text-accent-foreground',
        outside: 'day-outside text-muted-foreground aria-selected:bg-accent/50 aria-selected:text-muted-foreground',
        disabled: 'text-muted-foreground opacity-50',
        range_middle: 'aria-selected:bg-accent aria-selected:text-accent-foreground',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ className, ...props }) => {
          if (props.orientation === 'left') {
            return <ChevronLeft className={cn('size-4', className)} {...props} />;
          }

          if (props.orientation === 'right') {
            return <ChevronRight className={cn('size-4', className)} {...props} />;
          }

          if (props.orientation === 'up') {
            return <ChevronUp className={cn('size-4', className)} {...props} />;
          }

          return <ChevronDown className={cn('size-4', className)} {...props} />;
        },
      }}
      {...props}
    />
  );
}

export { Calendar };
