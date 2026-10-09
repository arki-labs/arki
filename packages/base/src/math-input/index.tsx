'use client';

import * as React from 'react';

import { Sigma } from '@arki/icons/phosphor';

import { Button } from '../button';
import { cn } from '../cn';
import { Input } from '../input';
import { Popover, PopoverContent, PopoverTrigger } from '../popover';
import { Separator } from '../separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../tabs';
import { CATEGORY_LABELS, CATEGORY_ORDER, MATH_CONSTANTS } from './constants';
import { displayToNumber, numberToDisplay, parseFraction } from './utils';

export type MathInputProps = {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Show +∞ / −∞ picker tab. Default: true */
  allowInfinity?: boolean;
  /** Show fraction picker tab. Default: true */
  allowFractions?: boolean;
  min?: number;
  max?: number;
};

function clamp(value: number | null, min?: number, max?: number): number | null {
  if (value === null) return null;
  // Pass ±Infinity through without clamping
  if (!Number.isFinite(value)) return value;
  let v = value;
  if (min !== undefined && v < min) v = min;
  if (max !== undefined && v > max) v = max;
  return v;
}

export function MathInput({
  value,
  onChange,
  placeholder = '0',
  disabled = false,
  className,
  allowInfinity = true,
  allowFractions = true,
  min,
  max,
}: MathInputProps) {
  const [open, setOpen] = React.useState(false);
  const [displayValue, setDisplayValue] = React.useState<string>(() => numberToDisplay(value));
  const [numerator, setNumerator] = React.useState('');
  const [denominator, setDenominator] = React.useState('');

  // Sync display string when value changes externally
  React.useEffect(() => {
    setDisplayValue(numberToDisplay(value));
  }, [value]);

  const tabList = React.useMemo(() => {
    const tabs: { value: string; label: string }[] = [{ value: 'constants', label: 'Constants' }];
    if (allowFractions) tabs.push({ value: 'fraction', label: 'Fraction' });
    if (allowInfinity) tabs.push({ value: 'infinity', label: 'Infinity' });
    return tabs;
  }, [allowInfinity, allowFractions]);

  const constantsByCategory = React.useMemo(
    () =>
      CATEGORY_ORDER.map(cat => ({
        category: cat,
        label: CATEGORY_LABELS[cat],
        items: MATH_CONSTANTS.filter(c => c.category === cat),
      })).filter(g => g.items.length > 0),
    [],
  );

  const fractionResult = React.useMemo(() => {
    if (!numerator || !denominator) return null;
    return parseFraction(Number(numerator), Number(denominator));
  }, [numerator, denominator]);

  const handleBlur = () => {
    const parsed = displayToNumber(displayValue);
    const clamped = clamp(parsed, min, max);
    onChange(clamped);
    setDisplayValue(numberToDisplay(clamped));
  };

  const handleConstantSelect = (constantValue: number) => {
    const clamped = clamp(constantValue, min, max);
    onChange(clamped);
    setDisplayValue(numberToDisplay(clamped));
    setOpen(false);
  };

  const handleInfinitySelect = (sign: 1 | -1) => {
    const infValue = sign === 1 ? Infinity : -Infinity;
    onChange(infValue);
    setDisplayValue(numberToDisplay(infValue));
    setOpen(false);
  };

  const handleFractionInsert = () => {
    if (fractionResult === null) return;
    const clamped = clamp(fractionResult, min, max);
    onChange(clamped);
    setDisplayValue(numberToDisplay(clamped));
    setNumerator('');
    setDenominator('');
    setOpen(false);
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <Input
        type="text"
        inputMode="decimal"
        placeholder={placeholder}
        value={displayValue}
        disabled={disabled}
        onChange={e => setDisplayValue(e.target.value)}
        onBlur={handleBlur}
        className="flex-1"
      />
      {!disabled && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
                aria-label="Open mathematical constant picker"
              />
            }
          >
            <Sigma className="size-4" />
          </PopoverTrigger>
          <PopoverContent className="w-80 p-0" align="end" sideOffset={6}>
            <Tabs defaultValue="constants" className="w-full">
              <TabsList className="w-full rounded-none border-b border-border bg-transparent">
                {tabList.map(tab => (
                  <TabsTrigger key={tab.value} value={tab.value} className="flex-1 text-xs">
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              {/* ── Constants ─────────────────────────────────────── */}
              <TabsContent value="constants" className="max-h-72 overflow-y-auto p-3">
                <div className="space-y-3">
                  {constantsByCategory.map(({ category, label, items }) => (
                    <div key={category}>
                      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {label}
                      </p>
                      <div className="grid grid-cols-4 gap-1">
                        {items.map(c => (
                          <Button
                            key={c.symbol}
                            variant="outline"
                            size="sm"
                            className="flex h-auto flex-col gap-0.5 px-1 py-2"
                            onClick={() => handleConstantSelect(c.value)}
                            title={`${c.name} ≈ ${c.value.toPrecision(6)}`}
                          >
                            <span className="text-base font-medium leading-none">{c.symbol}</span>
                            <span className="text-[9px] leading-none text-muted-foreground">
                              {c.name.split(' ')[0]}
                            </span>
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>

              {/* ── Fraction ──────────────────────────────────────── */}
              {allowFractions && (
                <TabsContent value="fraction" className="p-4">
                  <p className="mb-3 text-xs text-muted-foreground">
                    Enter a fraction — it will be stored as its decimal value.
                  </p>
                  <div className="flex flex-col items-center gap-1">
                    <input
                      type="number"
                      value={numerator}
                      onChange={e => setNumerator(e.target.value)}
                      placeholder="Numerator"
                      className="h-8 w-28 rounded-md border border-border bg-background px-2 text-center text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Fraction numerator"
                    />
                    <Separator className="w-28" />
                    <input
                      type="number"
                      value={denominator}
                      onChange={e => setDenominator(e.target.value)}
                      placeholder="Denominator"
                      className="h-8 w-28 rounded-md border border-border bg-background px-2 text-center text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Fraction denominator"
                    />
                  </div>
                  {fractionResult !== null && (
                    <p className="mt-2 text-center text-xs text-muted-foreground">= {fractionResult}</p>
                  )}
                  <Button
                    className="mt-3 w-full"
                    size="sm"
                    disabled={fractionResult === null}
                    onClick={handleFractionInsert}
                  >
                    Insert{numerator && denominator ? ` ${numerator}/${denominator}` : ' fraction'}
                  </Button>
                </TabsContent>
              )}

              {/* ── Infinity ──────────────────────────────────────── */}
              {allowInfinity && (
                <TabsContent value="infinity" className="p-4">
                  <p className="mb-3 text-xs text-muted-foreground">Select a signed infinity value.</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      className="flex h-auto flex-col gap-1 py-3"
                      onClick={() => handleInfinitySelect(1)}
                    >
                      <span className="text-2xl font-light">+∞</span>
                      <span className="text-xs text-muted-foreground">Positive</span>
                    </Button>
                    <Button
                      variant="outline"
                      className="flex h-auto flex-col gap-1 py-3"
                      onClick={() => handleInfinitySelect(-1)}
                    >
                      <span className="text-2xl font-light">−∞</span>
                      <span className="text-xs text-muted-foreground">Negative</span>
                    </Button>
                  </div>
                </TabsContent>
              )}
            </Tabs>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
