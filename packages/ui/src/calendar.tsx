'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';

import { CaretDown, CaretLeft, CaretRight, CaretUp } from '@arki/icons/phosphor';

import { buttonVariants } from './button';
import { cn } from './cn';

type CalendarProps = React.ComponentProps<typeof DayPicker> & {
  fullWidth?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  fullWidth = false,
  size = 'md',
  ...props
}: CalendarProps) {
  const sizeClasses = {
    sm: {
      padding: 'p-2',
      captionLabel: 'text-xs',
      navButtonSize: 'size-6',
      weekdayWidth: 'w-7',
      weekdayText: 'text-[0.7rem]',
      daySize: 'size-7',
      dayText: 'text-xs',
    },
    md: {
      padding: 'p-3',
      captionLabel: 'text-sm',
      navButtonSize: 'size-7',
      weekdayWidth: 'w-8',
      weekdayText: 'text-[0.8rem]',
      daySize: 'size-8',
      dayText: 'text-sm',
    },
    lg: {
      padding: 'p-4',
      captionLabel: 'text-base',
      navButtonSize: 'size-8',
      weekdayWidth: 'w-9',
      weekdayText: 'text-[0.9rem]',
      daySize: 'size-9',
      dayText: 'text-base',
    },
  };

  const currentSize = sizeClasses[size];

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn(currentSize.padding, fullWidth && 'w-full', className)}
      classNames={{
        months: 'flex flex-row sm:flex-col gap-2',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center w-full',
        caption_label: cn('font-medium', currentSize.captionLabel),
        nav: 'flex items-center gap-1 relative justify-between',
        button_previous: cn(
          buttonVariants({ variant: 'outline' }),
          'absolute top-5 left-1 bg-transparent p-0 opacity-50 hover:opacity-100',
          currentSize.navButtonSize,
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline' }),
          'absolute top-5 right-1 bg-transparent p-0 opacity-50 hover:opacity-100',
          currentSize.navButtonSize,
        ),
        table: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: cn(
          'flex-1',
          'text-muted-foreground flex items-center justify-center rounded-md font-normal',
          currentSize.weekdayText,
          !fullWidth && currentSize.weekdayWidth,
        ),
        week: 'flex w-full mt-2',
        day: cn(
          buttonVariants({ variant: 'ghost' }),
          'relative p-0 text-center font-normal focus-within:relative focus-within:z-20 aria-selected:opacity-100',
          'w-full',
          currentSize.daySize,
          currentSize.dayText,
          fullWidth && 'flex-1',
          '[&:has([aria-selected])]:bg-accent [&:has([aria-selected].day-outside)]:bg-accent/50',
          '[&:has([aria-selected].day-range-end)]:rounded-r-md',
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
            return <CaretLeft className={cn('size-4', className)} {...props} weight="regular" />;
          }

          if (props.orientation === 'right') {
            return <CaretRight className={cn('size-4', className)} {...props} weight="regular" />;
          }

          if (props.orientation === 'up') {
            return <CaretUp className={cn('size-4', className)} {...props} weight="regular" />;
          }

          return <CaretDown className={cn('size-4', className)} {...props} weight="regular" />;
        },
      }}
      {...props}
    />
  );
}

export { Calendar };
