'use client';

import { forwardRef } from 'react';
import { LuCalendar as CalendarIcon } from 'react-icons/lu';

import { format } from '@arki/date/format';

import { Button } from './button';
import { Calendar } from './calendar';
import { cn } from './cn';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export const DatePicker = forwardRef<
  HTMLDivElement,
  {
    date?: Date;
    setDate: (date?: Date) => void;
  }
>(function DatePickerCmp({ date, setDate }, ref) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={'outline'}
          className={cn('w-full justify-start text-left font-normal', !date && 'text-muted-foreground')}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, 'PPP') : <span>Pick a date</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" ref={ref}>
        <Calendar mode="single" selected={date} onSelect={setDate} autoFocus />
      </PopoverContent>
    </Popover>
  );
});
