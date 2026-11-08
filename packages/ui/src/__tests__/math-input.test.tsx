import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ComplexInput } from '../math-input/complex-input';
import { MathInput } from '../math-input/index';

describe('MathInput', () => {
  // A calculator result of 0/0 is NaN; showing it must not crash the page with "Too many re-renders".
  it('renders a NaN value', () => {
    const changes: (number | null)[] = [];
    render(<MathInput value={Number.NaN} onChange={value => changes.push(value)} />);
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('renders a complex number whose imaginary part is NaN', () => {
    const changes: (number | null)[] = [];
    render(
      <ComplexInput
        real={1}
        imag={Number.NaN}
        onRealChange={value => changes.push(value)}
        onImagChange={value => changes.push(value)}
      />,
    );
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
  });
});
