import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DatePicker } from '../date-picker';

describe('DatePicker', () => {
  it('shows the placeholder for an invalid Date instead of throwing a RangeError', () => {
    render(<DatePicker date={new Date(Number.NaN)} setDate={vi.fn()} />);
    expect(screen.getByText('Pick a date')).toBeTruthy();
  });

  it('shows the formatted date for a valid Date', () => {
    render(<DatePicker date={new Date(2026, 9, 5)} setDate={vi.fn()} />);
    expect(screen.getByText('October 5th, 2026')).toBeTruthy();
  });
});
