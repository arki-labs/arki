'use client';

import type { ComponentProps } from 'react';

import { format } from '@arki/date/format';
import { CalendarIcon } from '@arki/icons/phosphor';

import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from './cn';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

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
        {date ? format(date, 'PPP') : <span>Pick a date</span>}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" {...props}>
        <Calendar mode="single" selected={date} onSelect={setDate} autoFocus />
      </PopoverContent>
    </Popover>
  );
}
