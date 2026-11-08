import type { DateRange } from 'react-day-picker';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Calendar } from '../calendar';

describe('Calendar', () => {
  // A time zone often comes from a stored user profile; one bad value must not crash the page.
  it('renders with an unknown timeZone, in the browser time zone', () => {
    render(<Calendar timeZone="Not/AZone" defaultMonth={new Date(2026, 9, 1)} />);
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.getByText('October 2026')).toBeTruthy();
  });

  it('shows the current month for an Invalid Date month or defaultMonth', () => {
    const now = new Date();
    const caption = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(now);
    const { unmount } = render(<Calendar month={new Date(Number.NaN)} />);
    expect(screen.getByText(caption)).toBeTruthy();
    unmount();
    render(<Calendar defaultMonth={new Date(Number.NaN)} />);
    expect(screen.getByText(caption)).toBeTruthy();
  });

  it('shows the current month for an Invalid Date today', () => {
    render(<Calendar today={new Date(Number.NaN)} defaultMonth={new Date(2026, 9, 1)} />);
    expect(screen.getByText('October 2026')).toBeTruthy();
  });

  it('shows the current month for a month or endMonth in the first month of the Date range', () => {
    const caption = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(new Date());
    render(<Calendar month={new Date(-8.64e15)} />);
    expect(screen.getByText(caption)).toBeTruthy();
    cleanup();
    render(<Calendar endMonth={new Date(-8.64e15)} />);
    expect(screen.getByText(caption)).toBeTruthy();
  });

  it('starts a new range when a day is clicked while the stored range start is an Invalid Date', () => {
    const picked: (DateRange | undefined)[] = [];
    render(
      <Calendar
        mode="range"
        selected={{ from: new Date(Number.NaN), to: undefined }}
        onSelect={range => picked.push(range)}
        defaultMonth={new Date(2026, 9, 1)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /October 5th, 2026/ }));
    expect(picked).toHaveLength(1);
    expect(picked[0]?.from?.getDate()).toBe(5);
  });
});
