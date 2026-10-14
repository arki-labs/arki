'use client';

import { cn } from '../cn';
import { MathInput } from './index';

export type ComplexInputProps = {
  real: number | null;
  imag: number | null;
  onRealChange: (v: number | null) => void;
  onImagChange: (v: number | null) => void;
  disabled?: boolean;
  className?: string;
  /** Show ±∞ in the pickers. Defaults to false — infinite complex parts are rarely meaningful. */
  allowInfinity?: boolean;
  /** Show fraction picker. Default: true */
  allowFractions?: boolean;
};

/**
 * Two MathInput sub-components rendered as `a + bi`, representing the real
 * and imaginary parts of a complex number. Each part independently supports
 * constants, fractions, and (optionally) infinity.
 */
export function ComplexInput({
  real,
  imag,
  onRealChange,
  onImagChange,
  disabled,
  className,
  allowInfinity = false,
  allowFractions = true,
}: ComplexInputProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <MathInput
        value={real}
        onChange={onRealChange}
        placeholder="a"
        disabled={disabled}
        allowInfinity={allowInfinity}
        allowFractions={allowFractions}
        className="flex-1"
      />
      <span className="select-none text-sm text-muted-foreground" aria-hidden="true">
        +
      </span>
      <MathInput
        value={imag}
        onChange={onImagChange}
        placeholder="b"
        disabled={disabled}
        allowInfinity={allowInfinity}
        allowFractions={allowFractions}
        className="flex-1"
      />
      <span className="select-none text-sm font-medium" aria-hidden="true">
        i
      </span>
    </div>
  );
}
