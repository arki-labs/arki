/** Calendar: a month grid to pick days. */
'use client';

import * as React from 'react';
import { DayPicker } from 'react-day-picker';

import { isValidTimeZone } from '@arki/date/zone';
import { CaretDown, CaretLeft, CaretRight, CaretUp } from '@arki/icons/phosphor';
import { getLogger } from '@arki/log';

import { buttonVariants } from './button.js';
import { cn } from './cn.js';

/** Enable with `DEBUG=arki:ui:calendar`. */
const calendarLog = getLogger('arki:ui:calendar');

type CalendarProps = React.ComponentProps<typeof DayPicker> & {
  fullWidth?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

/** A month in milliseconds, rounded up, and the largest distance from 1970 a JS `Date` can hold. */
const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const DATE_RANGE_MS = 8.64e15;

/**
 * The date when react-day-picker can show it, else `undefined`. It throws "Invalid time value" in
 * render for an Invalid Date, and for a Date in the first month of the JS Date range (it computes the
 * month before). One month of margin at both ends keeps that check simple.
 */
function showableDate(date: Date | undefined): Date | undefined {
  return date && Math.abs(date.getTime()) < DATE_RANGE_MS - MONTH_MS ? date : undefined;
}

/**
 * A month grid. A `timeZone` often comes from a stored profile, so an unknown one falls back to the
 * browser's zone (logged at DEBUG) instead of throwing in render. A `month`, `defaultMonth`, `today`,
 * `startMonth` or `endMonth` that is an Invalid Date (or within a month of the ends of the Date range) is ignored, and a range
 * with such an end counts as no range.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  fullWidth = false,
  size = 'md',
  timeZone,
  month,
  defaultMonth,
  today,
  startMonth,
  endMonth,
  ...rest
}: CalendarProps) {
  const knownTimeZone = timeZone === undefined || isValidTimeZone(timeZone) ? timeZone : undefined;
  if (knownTimeZone !== timeZone) {
    calendarLog.debug('Unknown time zone {timeZone}; using the browser time zone', { timeZone });
  }
  // react-day-picker throws "Invalid range" when a day is clicked while a range end is an Invalid Date.
  const props =
    rest.mode === 'range' &&
    rest.selected &&
    (showableDate(rest.selected.from) !== rest.selected.from || showableDate(rest.selected.to) !== rest.selected.to)
      ? { ...rest, selected: undefined }
      : rest;

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
      timeZone={knownTimeZone}
      month={showableDate(month)}
      defaultMonth={showableDate(defaultMonth)}
      today={showableDate(today)}
      startMonth={showableDate(startMonth)}
      endMonth={showableDate(endMonth)}
      {...props}
    />
  );
}

export { Calendar };
