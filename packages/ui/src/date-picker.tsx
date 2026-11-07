/** Date picker: an input that opens a calendar. */
'use client';

import type { ComponentProps } from 'react';

import { format } from '@arki/date/format';
import { CalendarIcon } from '@arki/icons/phosphor';

import { Button } from './button.js';
import { Calendar } from './calendar.js';
import { cn } from './cn.js';
import { Popover, PopoverContent, PopoverTrigger } from './popover.js';

type DatePickerProps = {
  date?: Date;
  setDate: (date?: Date) => void;
} & ComponentProps<'div'>;

export function DatePicker({ date, setDate, ...props }: DatePickerProps) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={'outline'}
            className={cn('w-full justify-start text-left font-normal', !date && 'text-muted-foreground')}
          />
        }
      >
        <CalendarIcon className="mr-2 h-4 w-4" weight="regular" />
        {date && !Number.isNaN(date.getTime()) ? format(date, 'PPP') : <span>Pick a date</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" {...props}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- Calendar is a custom component: autoFocus moves focus to the day grid when the popover opens, which keyboard users need. */}
        <Calendar mode="single" selected={date} onSelect={setDate} autoFocus />
      </PopoverContent>
    </Popover>
  );
}
